/**
 * Cash receipts — an admin acknowledging that physical money reached them.
 *
 * A cash payment cannot settle itself: there is no webhook, only a person
 * saying "yes, I have the notes in my hand". Until they say so the transaction
 * sits pending and the member is credited nothing.
 *
 * That acknowledgement is an approval, so it is recorded as one: it moves real
 * money into someone's savings on one admin's word, and the group is entitled
 * to see who said it and when, in the same place it sees loans and removals.
 * It differs from the rest only in the bar — ONE admin, not a quorum, because
 * the person holding the cash is the one who knows.
 *
 * Both routes into it (the confirm button on the notification, and a vote on
 * the approvals screen) come through resolveCashReceipt, so the transaction and
 * the approval can never disagree about what happened.
 */
import { Approval } from "../models/Approval.js";
import { Notification } from "../models/Notification.js";
import { Transaction } from "../models/Transaction.js";
import { settleCompletedTransaction } from "./settlement.service.js";

/** Cash payments that need acknowledging: a plain contribution, or the unified
 *  checkout (savings + repayments + penalties paid as one lump). */
export const CASH_CONFIRMABLE_TYPES = ["contribution", "combined"];

const labelFor = (txn) => (txn.type === "combined" ? "payment" : "contribution");

/**
 * Raise the receipt for a pending cash transaction: one approval for the group's
 * record, plus a notification to whoever should be holding the money.
 *
 * The treasurer is asked first — they keep the cash box — and the chairperson
 * only when the group has no treasurer. Any admin may answer it, though: the
 * approval is what governs that, and a group whose treasurer is unreachable
 * must not have its members' savings frozen.
 */
export async function raiseCashReceipt({ group, txn, payerName }) {
  const amount = Math.abs(txn.amount);
  const label = labelFor(txn);

  const approval = await Approval.create({
    groupId: group._id,
    groupName: group.name,
    type: "cash-receipt",
    title: `Cash ${label} — ${payerName}`,
    description: `${payerName} says they handed over K${amount} in cash. Approve once you have the money.`,
    amount,
    requestedById: txn.memberId,
    requestedBy: payerName,
    refId: txn._id,
    // One admin. The cash is in someone's hands or it isn't; a second opinion
    // adds nothing but a delay to the member's savings.
    requiredApprovals: 1,
  });

  const active = group.members.filter((m) => m.status === "active" && m.userId);
  const treasurers = active.filter((m) => m.role === "Treasurer");
  const recipients = treasurers.length
    ? treasurers
    : active.filter((m) => m.role === "Chairperson");
  for (const admin of recipients) {
    await Notification.create({
      userId: admin.userId,
      type: "contribution",
      title: `Cash ${label} — confirm receipt`,
      body: `${payerName} recorded a K${amount} cash ${label} to ${group.name}. Confirm you received the cash to credit it.`,
      groupId: group._id,
      groupName: group.name,
      transactionId: txn._id,
    });
  }

  return approval;
}

/**
 * Settle or decline a pending cash transaction, and close the approval behind
 * it. Safe to call from either surface and safe to call twice: the status flip
 * is a single atomic pending→final update, so a double-tap, or a treasurer
 * confirming while a chairperson votes, resolves once and the loser is told.
 *
 * Returns { transaction } on success, or { error, status } to hand back.
 */
export async function resolveCashReceipt({ txn, admin, received }) {
  const updated = await Transaction.findOneAndUpdate(
    { _id: txn._id, status: "pending" },
    received
      ? {
          status: "completed",
          note: `${txn.note} — cash received by ${admin.name}`,
          "meta.cashConfirmedBy": admin.userId,
          "meta.cashConfirmedByName": admin.name,
        }
      : {
          status: "failed",
          note: `${txn.note} — cash not received (declined by ${admin.name})`,
          "meta.cashConfirmedBy": admin.userId,
          "meta.cashConfirmedByName": admin.name,
        },
    { new: true }
  );
  if (!updated)
    return { error: "Already confirmed or declined", status: 409 };

  if (received) await settleCompletedTransaction(updated);

  // Close the approval this receipt was raised as, unless the vote route is
  // already doing it (it claims the approval before executing, and passes
  // skipApproval so we don't stamp a second, contradictory decision).
  if (!admin.skipApproval) {
    await Approval.findOneAndUpdate(
      { refId: updated._id, type: "cash-receipt", status: "pending" },
      {
        status: received ? "approved" : "rejected",
        $push: {
          votes: {
            adminId: admin.userId,
            adminName: admin.name,
            decision: received ? "approve" : "reject",
          },
        },
      }
    );
  }

  // Tell the payer either way — a declined receipt is the more urgent of the
  // two, since their money is somewhere and their savings are not.
  if (updated.memberId && String(updated.memberId) !== String(admin.userId)) {
    const label = labelFor(updated);
    await Notification.create({
      userId: updated.memberId,
      type: "contribution",
      title: received ? `Cash ${label} confirmed` : `Cash ${label} declined`,
      body: received
        ? `${admin.name} confirmed receiving your K${Math.abs(updated.amount)} cash ${label}. Your account has been updated.`
        : `${admin.name} declined your K${Math.abs(updated.amount)} cash ${label} — the cash was not received. Please speak to your treasurer.`,
      groupId: updated.groupId,
      groupName: updated.groupName,
      transactionId: updated._id,
    });
  }

  return { transaction: updated };
}

export default { raiseCashReceipt, resolveCashReceipt, CASH_CONFIRMABLE_TYPES };
