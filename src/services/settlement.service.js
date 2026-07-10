import { Group } from "../models/Group.js";
import { Loan } from "../models/Loan.js";
import { Penalty } from "../models/Penalty.js";
import { Notification } from "../models/Notification.js";
import { PlatformRevenue } from "../models/PlatformRevenue.js";
import { advancePaidThrough } from "./logic.service.js";

/**
 * Settlement service — the ONLY place payment side effects are applied.
 *
 * Money-moving routes initiate a PawaPay deposit/payout and record a pending
 * Transaction, but do NOT touch balances or domain state. When the payment
 * reaches a final status (webhook callback, reconciliation cron, or inline for
 * Cash/simulated payments that complete immediately):
 *   COMPLETED → settleCompletedTransaction(txn) applies the effects
 *   FAILED    → handleFailedTransaction(txn) notifies; there is nothing to
 *               undo because nothing was applied at initiation
 *
 * Exactly-once: callers must invoke these ONLY after winning the atomic
 * pending→final Transaction.findOneAndUpdate guard, so a callback and the
 * cron can never both settle the same transaction.
 *
 * Linkage each transaction needs in txn.meta (set at initiation):
 *   penalty    → { penaltyId }
 *   fee        → { months }
 *   repayment  → { loanId }
 *   loan       → { loanId }            (disbursement payout)
 *   share-out  → { memberSavings }     (member's savings snapshot at share-out)
 */

export async function settleCompletedTransaction(txn) {
  switch (txn.type) {
    case "contribution": {
      const amount = Math.abs(txn.amount);
      // $inc avoids the read-modify-write race when members settle concurrently
      await Group.updateOne(
        { _id: txn.groupId, "members.userId": txn.memberId },
        {
          $inc: {
            "members.$.savings": amount,
            "members.$.contributions": 1,
            totalSavings: amount,
            walletBalance: amount,
          },
        }
      );

      // Book the platform fee as a SIDE record only — it is never pooled and
      // touches no group/wallet/savings figure. Runs inside this branch so it
      // inherits the caller's exactly-once pending→final guard: it books once
      // when the transaction settles, and PlatformRevenue's unique+sparse
      // transactionId index blocks any replayed callback / cron double-fire.
      if (txn.platformFee && txn.platformFee > 0) {
        try {
          await PlatformRevenue.create({
            groupId: txn.groupId,
            transactionId: txn._id,
            userId: txn.memberId, // the payer this txn carries
            amount: txn.platformFee,
            source: "contribution",
            currency: "ZMW",
          });
        } catch (err) {
          // Duplicate key (11000) = this txn's revenue was ALREADY booked by a
          // prior settlement (replayed callback / cron double-fire). That's the
          // exactly-once guard working — swallow it. Re-throw anything else.
          if (err?.code !== 11000) throw err;
        }
      }
      return;
    }

    case "penalty": {
      // One transaction can settle SEVERAL penalties (paid together in a single
      // deposit — POST /penalties/pay). meta.penaltyId is the older single-pay
      // shape; keep reading it so transactions already pending when this shipped
      // still settle.
      const ids = txn.meta?.penaltyIds?.length
        ? txn.meta.penaltyIds
        : txn.meta?.penaltyId
          ? [txn.meta.penaltyId]
          : [];
      if (!ids.length) return;

      // Atomic claim (status → paid) PER penalty: two payment transactions for
      // the same penalty settling concurrently must credit the pool exactly
      // once — a read-check-save here would let both pass the "already paid"
      // check. Each claim is independent, so a partially-claimed batch (one
      // penalty already settled by another txn) still credits the rest exactly
      // once rather than skipping them.
      let pooled = 0;
      for (const id of ids) {
        const penalty = await Penalty.findOneAndUpdate(
          { _id: id, status: { $ne: "paid" } },
          { status: "paid" }
        );
        if (!penalty) continue; // missing or already settled
        // Route funds: group pool adds to walletBalance/totalSavings.
        if (penalty.fundsDestination === "group-pool") pooled += penalty.amount;
      }

      // One write for the whole batch rather than one per penalty.
      if (pooled > 0) {
        await Group.findByIdAndUpdate(txn.groupId, {
          $inc: { walletBalance: pooled, totalSavings: pooled },
        });
      }
      return;
    }

    case "fee": {
      const months = Number(txn.meta?.months) || 1;
      // CAS loop: feePaidThrough is date arithmetic on its own current value,
      // so guard the write on the value we read — otherwise a concurrent fee
      // settlement overwrites ours and paid months are silently lost.
      for (let attempt = 0; attempt < 5; attempt++) {
        const group = await Group.findById(txn.groupId)
          .select("feePaidThrough")
          .lean();
        if (!group) return;
        const { modifiedCount } = await Group.updateOne(
          { _id: txn.groupId, feePaidThrough: group.feePaidThrough ?? null },
          { $set: { feePaidThrough: advancePaidThrough(group, months) } }
        );
        if (modifiedCount) return;
      }
      console.error(
        `[SETTLEMENT] fee CAS exhausted for group ${txn.groupId} (txn ${txn._id})`
      );
      return;
    }

    case "repayment": {
      if (!txn.meta?.loanId) return;
      // CAS on outstanding: clamp against the balance we read, and only apply
      // if it hasn't moved — two repayments settling concurrently must never
      // double-advance the due date or push the balance below zero.
      let loan = null;
      let payAmount = 0;
      for (let attempt = 0; attempt < 5 && !loan; attempt++) {
        const current = await Loan.findById(txn.meta.loanId).lean();
        if (!current) return;
        payAmount = Math.min(Math.abs(txn.amount), current.outstanding);
        if (payAmount <= 0) return;
        loan = await Loan.findOneAndUpdate(
          { _id: current._id, outstanding: current.outstanding },
          {
            $inc: { outstanding: -payAmount, installmentsPaid: 1 },
            $push: { history: { amount: payAmount, type: "repayment" } },
          },
          { new: true }
        );
      }
      if (!loan) {
        console.error(
          `[SETTLEMENT] repayment CAS exhausted for loan ${txn.meta.loanId} (txn ${txn._id})`
        );
        return;
      }
      if (loan.outstanding <= 0) {
        await Loan.updateOne(
          { _id: loan._id },
          { $set: { outstanding: 0, status: "repaid" } }
        );
        loan.outstanding = 0;
      } else if (loan.installmentsPaid < loan.totalInstallments) {
        // Still outstanding and within term: advance the due date one month
        const next = new Date(loan.nextDueDate || Date.now());
        next.setMonth(next.getMonth() + 1);
        await Loan.updateOne({ _id: loan._id }, { $set: { nextDueDate: next } });
      }

      // Atomic $inc/$set on the group: a full-document save() here writes a
      // stale absolute walletBalance over any concurrent settlement's $inc.
      await Group.updateOne(
        { _id: loan.groupId },
        {
          $inc: { loanCirculation: -payAmount, walletBalance: payAmount },
          ...(loan.memberId
            ? { $set: { "members.$[m].loanActive": loan.outstanding } }
            : {}),
        },
        loan.memberId ? { arrayFilters: [{ "m.userId": loan.memberId }] } : {}
      );
      await Group.updateOne(
        { _id: loan.groupId, loanCirculation: { $lt: 0 } },
        { $set: { loanCirculation: 0 } }
      );
      return;
    }

    case "loan": {
      // Disbursement payout completed: the member has the money — activate.
      // Atomic claim on the pending status: a duplicate settlement must not
      // double-apply the circulation/wallet effects.
      const loan = txn.meta?.loanId
        ? await Loan.findOneAndUpdate(
            { _id: txn.meta.loanId, status: "pending" },
            {
              status: "active",
              nextDueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            },
            { new: true }
          )
        : null;
      if (!loan) return; // missing, already active, or otherwise not disbursable
      await Loan.updateOne(
        { _id: loan._id },
        { $push: { history: { amount: loan.principal, type: "disbursement" } } }
      );

      await Group.updateOne(
        { _id: loan.groupId },
        {
          $inc: { loanCirculation: loan.principal, walletBalance: -loan.principal },
          ...(loan.memberId
            ? { $set: { "members.$[m].loanActive": loan.outstanding } }
            : {}),
        },
        loan.memberId ? { arrayFilters: [{ "m.userId": loan.memberId }] } : {}
      );
      await Group.updateOne(
        { _id: loan.groupId, walletBalance: { $lt: 0 } },
        { $set: { walletBalance: 0 } }
      );

      // The borrower received the full principal, so Chuma paid the PawaPay +
      // MNO fee. Book that as NEGATIVE platform revenue — a cash cost, not a
      // charge to anyone. A SIDE record only: it touches no group/wallet/
      // loanCirculation/loan/member figure. Runs inside this branch so it
      // inherits the caller's exactly-once pending→final guard: it books once
      // when the disbursement settles, and PlatformRevenue's unique+sparse
      // transactionId index blocks any replayed callback / cron double-fire.
      if (txn.feesAbsorbed && txn.feesAbsorbed > 0) {
        try {
          await PlatformRevenue.create({
            groupId: txn.groupId,
            transactionId: txn._id,
            userId: txn.memberId, // the borrower — who the cost was incurred for
            amount: -txn.feesAbsorbed,
            source: "payout",
            currency: "ZMW",
          });
        } catch (err) {
          // Duplicate key (11000) = this txn's revenue was ALREADY booked by a
          // prior settlement (replayed callback / cron double-fire). That's the
          // exactly-once guard working — swallow it. Re-throw anything else.
          if (err?.code !== 11000) throw err;
        }
      }

      if (loan.memberId) {
        await Notification.create({
          userId: loan.memberId,
          type: "loan",
          title: "Loan disbursed",
          body: `Your loan of K${loan.principal} has been sent to your mobile wallet.`,
          groupId: loan.groupId,
          groupName: loan.groupName,
        });
      }
      return;
    }

    case "share-out": {
      // This member's payout landed: retire their stake from the cycle.
      // Atomic $set/$inc, NOT read-modify-write .save(): several share-out
      // callbacks settle near-simultaneously and each would clobber the
      // others' rollup decrements and see stale member savings, leaving the
      // cycle permanently open (same race the contribution case avoids).
      const snapshot = Math.max(0, Number(txn.meta?.memberSavings) || 0);
      const share = Math.abs(txn.amount); // savings + profit portion paid out
      await Group.updateOne(
        { _id: txn.groupId },
        {
          ...(txn.memberId
            ? { $set: { "members.$[m].savings": 0, "members.$[m].contributions": 0 } }
            : {}),
          // The share left the group's wallet when the payout completed —
          // without this the wallet overstates cash on hand.
          $inc: { totalSavings: -snapshot, walletBalance: -share },
        },
        txn.memberId ? { arrayFilters: [{ "m.userId": txn.memberId }] } : {}
      );

      // Book the platform fee as a SIDE record only — never pooled, touches no
      // group/wallet/savings figure. source "payout" separates payout-side
      // revenue from collection-side. Runs inside this branch so it inherits the
      // caller's exactly-once pending→final guard: it books once when the payout
      // settles, and PlatformRevenue's unique+sparse transactionId index blocks
      // any replayed callback / cron double-fire.
      if (txn.platformFee && txn.platformFee > 0) {
        try {
          await PlatformRevenue.create({
            groupId: txn.groupId,
            transactionId: txn._id,
            userId: txn.memberId, // the member being paid out
            amount: txn.platformFee,
            source: "payout",
            currency: "ZMW",
          });
        } catch (err) {
          // Duplicate key (11000) = this txn's revenue was ALREADY booked by a
          // prior settlement (replayed callback / cron double-fire). That's the
          // exactly-once guard working — swallow it. Re-throw anything else.
          if (err?.code !== 11000) throw err;
        }
      }

      // Once every active member's stake is retired, the cycle is over; the
      // closing $set also normalises any drift the $inc left below zero.
      const group = await Group.findById(txn.groupId).lean();
      if (!group) return;
      const anyLeft = group.members.some(
        (m) => m.status === "active" && m.savings > 0
      );
      const fix = {};
      if (group.totalSavings < 0) fix.totalSavings = 0;
      if (group.walletBalance < 0) fix.walletBalance = 0;
      if (!anyLeft) {
        fix.totalSavings = 0;
        fix.cycleProgress = 0;
      }
      if (Object.keys(fix).length)
        await Group.updateOne({ _id: group._id }, { $set: fix });
      return;
    }

    default:
      return; // withdrawal etc. — no settlement effects defined
  }
}

const FAIL_LABELS = {
  contribution: "contribution",
  penalty: "penalty payment",
  fee: "group fee payment",
  repayment: "loan repayment",
  loan: "loan disbursement",
  "share-out": "share-out payout",
};

// Notification.type enum has no generic "payment"; reuse the closest type.
const FAIL_NOTIF_TYPE = {
  contribution: "contribution",
  penalty: "penalty",
  fee: "fee",
  repayment: "repayment",
  loan: "loan",
  "share-out": "governance",
};

/**
 * A payment reached FAILED. Nothing was applied at initiation, so there is
 * nothing to undo — but the people involved must know.
 */
export async function handleFailedTransaction(txn) {
  const label = FAIL_LABELS[txn.type] || "payment";
  const notifType = FAIL_NOTIF_TYPE[txn.type] || "governance";
  const amount = Math.abs(txn.amount);
  const isPayout = txn.type === "loan" || txn.type === "share-out";

  if (txn.memberId) {
    await Notification.create({
      userId: txn.memberId,
      type: notifType,
      title: `${label[0].toUpperCase()}${label.slice(1)} failed`,
      body: isPayout
        ? `Your ${label} of K${amount} could not be sent to your wallet. The group admins have been notified to retry.`
        : `Your ${label} of K${amount} was not completed by your mobile money provider. No balances were changed — please try again.`,
      groupId: txn.groupId,
      groupName: txn.groupName,
    });
  }

  // Failed payouts mean the group still holds money it believes it sent out —
  // admins must retry (disbursement) or re-run the member's share-out.
  if (isPayout && txn.groupId) {
    const group = await Group.findById(txn.groupId).lean();
    const admins = (group?.members || []).filter(
      (m) =>
        (m.role === "Chairperson" || m.role === "Treasurer") &&
        m.status === "active" &&
        m.userId
    );
    for (const admin of admins) {
      await Notification.create({
        userId: admin.userId,
        type: notifType,
        title: `${label[0].toUpperCase()}${label.slice(1)} failed`,
        body: `The ${label} of K${amount} to ${txn.memberName || "a member"} failed at the mobile money provider. Funds were not sent — please retry.`,
        groupId: txn.groupId,
        groupName: txn.groupName,
        // Lets the app attach a "Retry payout" action to this notification
        transactionId: txn._id,
      });
    }
  }
}

export default { settleCompletedTransaction, handleFailedTransaction };
