import { Group } from "../models/Group.js";
import { Loan } from "../models/Loan.js";
import { Penalty } from "../models/Penalty.js";
import { Notification } from "../models/Notification.js";
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
      return;
    }

    case "penalty": {
      const penalty = txn.meta?.penaltyId
        ? await Penalty.findById(txn.meta.penaltyId)
        : null;
      if (!penalty || penalty.status === "paid") return; // already settled
      penalty.status = "paid";
      await penalty.save();
      // Route funds: group pool adds to walletBalance/totalSavings
      if (penalty.fundsDestination === "group-pool") {
        await Group.findByIdAndUpdate(txn.groupId, {
          $inc: { walletBalance: penalty.amount, totalSavings: penalty.amount },
        });
      }
      return;
    }

    case "fee": {
      const months = Number(txn.meta?.months) || 1;
      const group = await Group.findById(txn.groupId);
      if (!group) return;
      group.feePaidThrough = advancePaidThrough(group, months);
      await group.save();
      return;
    }

    case "repayment": {
      const loan = txn.meta?.loanId ? await Loan.findById(txn.meta.loanId) : null;
      if (!loan) return;
      // Clamp again at settlement: another repayment may have settled first
      const payAmount = Math.min(Math.abs(txn.amount), loan.outstanding);
      if (payAmount <= 0) return;
      loan.outstanding -= payAmount;
      loan.installmentsPaid += 1;
      loan.history.push({ amount: payAmount, type: "repayment" });
      if (loan.outstanding <= 0) {
        loan.outstanding = 0;
        loan.status = "repaid";
      } else if (loan.installmentsPaid < loan.totalInstallments) {
        // Still outstanding and within term: advance the due date one month
        const next = new Date(loan.nextDueDate || Date.now());
        next.setMonth(next.getMonth() + 1);
        loan.nextDueDate = next;
      }
      await loan.save();

      const group = await Group.findById(loan.groupId);
      if (group) {
        group.loanCirculation = Math.max(0, group.loanCirculation - payAmount);
        group.walletBalance += payAmount;
        const member = group.members.find(
          (m) => String(m.userId) === String(loan.memberId)
        );
        if (member) member.loanActive = loan.outstanding;
        await group.save();
      }
      return;
    }

    case "loan": {
      // Disbursement payout completed: the member has the money — activate.
      const loan = txn.meta?.loanId ? await Loan.findById(txn.meta.loanId) : null;
      if (!loan || loan.status === "active") return;
      loan.status = "active";
      loan.nextDueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      loan.history.push({ amount: loan.principal, type: "disbursement" });
      await loan.save();

      const group = await Group.findById(loan.groupId);
      if (group) {
        group.loanCirculation += loan.principal;
        group.walletBalance = Math.max(0, group.walletBalance - loan.principal);
        const gm = group.members.find(
          (m) => String(m.userId) === String(loan.memberId)
        );
        if (gm) gm.loanActive = loan.outstanding;
        await group.save();
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
      const snapshot = Math.max(0, Number(txn.meta?.memberSavings) || 0);
      const group = await Group.findById(txn.groupId);
      if (!group) return;
      const member = group.members.find(
        (m) => String(m.userId) === String(txn.memberId)
      );
      if (member) {
        member.savings = 0;
        member.contributions = 0;
      }
      group.totalSavings = Math.max(0, group.totalSavings - snapshot);
      // Once every active member's stake is retired, the cycle is over.
      const anyLeft = group.members.some(
        (m) => m.status === "active" && m.savings > 0
      );
      if (!anyLeft) {
        group.totalSavings = 0;
        group.cycleProgress = 0;
      }
      await group.save();
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
