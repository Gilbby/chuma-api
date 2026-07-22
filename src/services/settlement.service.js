import { Group } from "../models/Group.js";
import { Loan } from "../models/Loan.js";
import { Penalty } from "../models/Penalty.js";
import { Notification } from "../models/Notification.js";
import { PlatformRevenue } from "../models/PlatformRevenue.js";
import { Transaction } from "../models/Transaction.js";
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
 *   combined   → { contribution, topup, repayments:[{loanId,amount}], penaltyIds:[] }
 */

// ─── Reusable effect helpers ─────────────────────────────────────────────────
// Each applies ONE kind of side effect with its own atomic guard, so the same
// logic composes safely whether it settles a single-type transaction or one
// leg of a "combined" deposit. They never assume they are the whole transaction
// (no reading of txn.amount for figures) — the caller passes explicit amounts.

/**
 * Credit a member's savings (regular contribution + any top-up) and roll it up
 * into the group. $inc avoids the read-modify-write race when members settle
 * concurrently. Counts as ONE contribution event regardless of top-up.
 */
async function creditMemberSavings({ groupId, memberId, amount }) {
  if (!(amount > 0)) return;
  await Group.updateOne(
    { _id: groupId, "members.userId": memberId },
    {
      $inc: {
        "members.$.savings": amount,
        "members.$.contributions": 1,
        totalSavings: amount,
        walletBalance: amount,
      },
    }
  );
}

/**
 * Book a collection-side platform fee as a SIDE record only — it is never
 * pooled and touches no group/wallet/savings figure. PlatformRevenue's
 * unique+sparse transactionId index makes this exactly-once: a replayed
 * callback / cron double-fire hits a duplicate key (11000), which we swallow.
 * One transaction books at most one platform-fee record, so combined deposits
 * (many obligations, one fee) still book exactly once.
 */
async function bookCollectionPlatformFee(txn) {
  if (!(txn.platformFee > 0)) return;
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
    if (err?.code !== 11000) throw err;
  }
}

/**
 * Settle a batch of penalties in ONE pass. Atomic claim (status → paid) PER
 * penalty: two payment transactions for the same penalty settling concurrently
 * must credit the pool exactly once — a read-check-save would let both pass the
 * "already paid" check. Each claim is independent, so a partially-claimed batch
 * still credits the rest exactly once rather than skipping them.
 */
async function settlePenaltyBatch({ groupId, penaltyIds }) {
  let pooled = 0;
  for (const id of penaltyIds) {
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
    await Group.findByIdAndUpdate(groupId, {
      $inc: { walletBalance: pooled, totalSavings: pooled },
    });
  }
}

/**
 * Apply ONE loan repayment of `amount` against `loanId`. CAS on outstanding:
 * clamp against the balance we read, and only apply if it hasn't moved — two
 * repayments settling concurrently must never double-advance the due date or
 * push the balance below zero.
 */
async function applyLoanRepayment({ loanId, amount }) {
  let loan = null;
  let payAmount = 0;
  for (let attempt = 0; attempt < 5 && !loan; attempt++) {
    const current = await Loan.findById(loanId).lean();
    if (!current) return;
    payAmount = Math.min(Math.abs(amount), current.outstanding);
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
    console.error(`[SETTLEMENT] repayment CAS exhausted for loan ${loanId}`);
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
}

export async function settleCompletedTransaction(txn) {
  switch (txn.type) {
    case "contribution": {
      await creditMemberSavings({
        groupId: txn.groupId,
        memberId: txn.memberId,
        amount: Math.abs(txn.amount),
      });
      // Runs inside this branch so it inherits the caller's exactly-once
      // pending→final guard (see bookCollectionPlatformFee).
      await bookCollectionPlatformFee(txn);
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
      await settlePenaltyBatch({ groupId: txn.groupId, penaltyIds: ids });
      return;
    }

    case "combined": {
      // One deposit settling several obligations at once. Each leg reuses the
      // same atomic helper as its single-type counterpart, so exactly-once
      // still holds per leg; the one platform fee books once for the whole txn.
      const m = txn.meta || {};
      const savings =
        (Number(m.contribution) || 0) + (Number(m.topup) || 0);
      await creditMemberSavings({
        groupId: txn.groupId,
        memberId: txn.memberId,
        amount: savings,
      });
      for (const r of m.repayments || []) {
        if (r?.loanId) await applyLoanRepayment({ loanId: r.loanId, amount: r.amount });
      }
      const penaltyIds = m.penaltyIds?.length ? m.penaltyIds : [];
      if (penaltyIds.length)
        await settlePenaltyBatch({ groupId: txn.groupId, penaltyIds });
      await bookCollectionPlatformFee(txn);
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
      await applyLoanRepayment({ loanId: txn.meta.loanId, amount: txn.amount });
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

      // The borrower bore the fees (netted OUT of the principal), so our 1%
      // platform fee is EARNED revenue — booked positive, source "payout", the
      // same as a share-out. A SIDE record only: it touches no group/wallet/
      // loanCirculation/loan/member figure. Runs inside this branch so it
      // inherits the caller's exactly-once pending→final guard: it books once
      // when the disbursement settles, and PlatformRevenue's unique+sparse
      // transactionId index blocks any replayed callback / cron double-fire.
      if (txn.platformFee && txn.platformFee > 0) {
        try {
          await PlatformRevenue.create({
            groupId: txn.groupId,
            transactionId: txn._id,
            userId: txn.memberId, // the borrower
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

      if (loan.memberId) {
        const net = txn.depositAmount ?? loan.principal;
        const fees = Math.max(0, loan.principal - net);
        await Notification.create({
          userId: loan.memberId,
          type: "loan",
          title: "Loan disbursed",
          body: `Your K${loan.principal} loan was sent to your mobile wallet as K${net}${fees > 0 ? ` (K${fees.toFixed(2)} in fees)` : ""}. You repay K${loan.outstanding}.`,
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
  combined: "payment",
};

// Notification.type enum has no generic "payment"; reuse the closest type.
const FAIL_NOTIF_TYPE = {
  contribution: "contribution",
  penalty: "penalty",
  fee: "fee",
  repayment: "repayment",
  loan: "loan",
  "share-out": "governance",
  combined: "contribution",
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

const PAYOUT_FINAL = ["COMPLETED", "FAILED", "REJECTED"];

/**
 * Reconcile ONE payout transfer's final status (COMPLETED / FAILED) into its
 * parent transaction. A payout can be several transfers — a large amount is
 * split into ≤operator-ceiling chunks (see pawapay.service) — and the parent
 * settles ONLY when EVERY transfer COMPLETES.
 *
 * Shared by the webhook and the reconciliation cron. Two atomic layers keep it
 * exactly-once under concurrent transfer callbacks:
 *   1. mark THIS transfer final — guarded on it being non-final (so a replayed
 *      callback is a no-op);
 *   2. once no transfer is still in flight: if ALL COMPLETED, flip the parent
 *      pending→completed and settle once; if ≥1 failed, flip pending→failed and
 *      notify once. The parent flip is guarded on status:"pending", so only one
 *      transfer's callback ever applies the effects.
 *
 * Returns "applied" | "chunk-marked" | "no-op".
 */
export async function applyPayoutChunkStatus(payoutId, status, failureReason) {
  if (!payoutId || typeof payoutId !== "string") return "no-op";
  if (status !== "COMPLETED" && status !== "FAILED") return "no-op";

  // 1) Atomically mark this transfer final — only if it isn't already (the
  // positional `$` targets the element the $elemMatch found). A replay for an
  // already-final transfer matches nothing → parent is null → no-op.
  const parent = await Transaction.findOneAndUpdate(
    { "pawapay.transfers": { $elemMatch: { payoutId, status: { $nin: PAYOUT_FINAL } } } },
    {
      $set: {
        "pawapay.transfers.$.status": status,
        ...(failureReason
          ? { "pawapay.transfers.$.failureReason": JSON.stringify(failureReason) }
          : {}),
      },
    },
    { new: true }
  );
  if (!parent) return "no-op";

  const transfers = parent.pawapay?.transfers || [];
  if (transfers.some((t) => !PAYOUT_FINAL.includes(t.status))) return "chunk-marked"; // still in flight

  const allCompleted = transfers.every((t) => t.status === "COMPLETED");
  // Surface a parent-level failure reason (the first failed transfer's) so the
  // UI and admin "retry" notifications read it where the single-payout field was.
  const failReason = allCompleted
    ? null
    : transfers.find((t) => t.status !== "COMPLETED" && t.failureReason)?.failureReason;
  const won = await Transaction.findOneAndUpdate(
    { _id: parent._id, status: "pending" },
    {
      status: allCompleted ? "completed" : "failed",
      "pawapay.status": allCompleted ? "COMPLETED" : "FAILED",
      ...(failReason ? { "pawapay.failureReason": failReason } : {}),
    },
    { new: true }
  );
  if (!won) return "no-op"; // another transfer's callback already finalised the parent

  try {
    if (allCompleted) await settleCompletedTransaction(won);
    else await handleFailedTransaction(won);
  } catch (err) {
    console.error(
      `[SETTLEMENT] FAILED to apply effects for txn ${won._id} (${won.type}, ${allCompleted ? "COMPLETED" : "FAILED"}):`,
      err
    );
  }
  return "applied";
}

export default {
  settleCompletedTransaction,
  handleFailedTransaction,
  applyPayoutChunkStatus,
};
