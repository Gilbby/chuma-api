/**
 * Cash receipts - an admin acknowledging that physical money reached them.
 *
 * A cash payment cannot settle itself: there is no webhook, only a person
 * saying "yes, I have the notes in my hand". Until they say so the transaction
 * sits pending and the member is credited nothing.
 *
 * That acknowledgement is an approval, so it is recorded as one: it moves real
 * money into someone's savings on one admin's word, and the group is entitled
 * to see who said it and when, in the same place it sees loans and removals.
 * It differs from the rest only in the bar - ONE admin, not a quorum, because
 * the person holding the cash is the one who knows.
 *
 * The one admin is the treasurer, who keeps the cash box, and the chairperson
 * only in a group that has no treasurer. Any admin may still answer a receipt -
 * a treasurer on a bus must not freeze the group's savings - but the duty is
 * named, and the chairperson is told by SMS whenever cash is confirmed, so the
 * handover is witnessed by someone other than the person holding the notes.
 *
 * Both routes into it (the confirm button on the notification, and a vote on
 * the approvals screen) come through resolveCashReceipt, so the transaction and
 * the approval can never disagree about what happened.
 */
import { Approval } from "../models/Approval.js";
import { Group } from "../models/Group.js";
import { Transaction } from "../models/Transaction.js";
import { notify, notifyAll } from "./notify.service.js";
import { settleCompletedTransaction } from "./settlement.service.js";

/** Cash payments that need acknowledging: a plain contribution, the unified
 *  checkout (savings + repayments + penalties paid as one lump), or a single
 *  loan repayment / penalty paid straight from its own screen. */
export const CASH_CONFIRMABLE_TYPES = [
  "contribution",
  "combined",
  "repayment",
  "penalty",
];

const LABELS = {
  contribution: "contribution",
  combined: "payment",
  repayment: "loan repayment",
  penalty: "penalty payment",
};

const labelFor = (txn) => LABELS[txn.type] || "payment";

/**
 * How the money arrived, in words. Church giving can come as a transfer
 * straight into the church's bank / mobile-money account instead of notes
 * (meta.channel - see funds.service.js); the receipt and every message about
 * it must say which, or a treasurer goes looking for cash nobody handed over.
 */
function arrival(txn) {
  const channel = txn.meta?.channel;
  const ref = txn.meta?.reference ? ` (ref ${txn.meta.reference})` : "";
  if (channel === "bank")
    return {
      channel,
      noun: "bank transfer",
      said: `transferred K${Math.abs(txn.amount)} into the church bank account${ref}`,
      check: "Approve once you see it in the account.",
      confirm: "confirmed the bank transfer",
    };
  if (channel === "mobile-money")
    return {
      channel,
      noun: "mobile money transfer",
      said: `sent K${Math.abs(txn.amount)} to the church mobile money${ref}`,
      check: "Approve once you see it in the account.",
      confirm: "confirmed the mobile money transfer",
    };
  return {
    channel: channel || null,
    noun: "cash",
    said: `handed over K${Math.abs(txn.amount)} in cash`,
    check: "Approve once you have the money.",
    confirm: "confirmed receiving the cash",
  };
}

/**
 * Raise the receipt for a pending cash transaction: one approval for the group's
 * record, plus a notification to whoever should be holding the money.
 *
 * The treasurer is asked first - they keep the cash box - and the chairperson
 * only when the group has no treasurer. Any admin may answer it, though: the
 * approval is what governs that, and a group whose treasurer is unreachable
 * must not have its members' savings frozen.
 */
export async function raiseCashReceipt({ group, txn, payerName }) {
  const amount = Math.abs(txn.amount);
  const label = labelFor(txn);
  const how = arrival(txn);
  // Church giving names what it was for, so the confirmer sees it too.
  const project = txn.meta?.projectId
    ? (group.projects || []).find((p) => String(p._id) === String(txn.meta.projectId))
    : null;
  const projectName = project?.name ?? (how.channel ? "General giving" : undefined);

  const active = group.members.filter((m) => m.status === "active" && m.userId);
  const treasurers = active.filter((m) => m.role === "Treasurer");
  // Whose duty this is. Treasurer by default - they keep the cash box - and
  // the chairperson only as the fallback for a group that has no treasurer.
  const confirmerRole = treasurers.length ? "Treasurer" : "Chairperson";
  const recipients = treasurers.length
    ? treasurers
    : active.filter((m) => m.role === "Chairperson");

  const approval = await Approval.create({
    groupId: group._id,
    groupName: group.name,
    type: "cash-receipt",
    title: how.noun === "cash" ? `Cash ${label} - ${payerName}` : `${how.noun[0].toUpperCase()}${how.noun.slice(1)} - ${payerName}`,
    description: `${payerName} says they ${how.said}. ${how.check}`,
    amount,
    requestedById: txn.memberId,
    requestedBy: payerName,
    refId: txn._id,
    confirmerRole,
    ...(how.channel
      ? { channel: how.channel, reference: txn.meta?.reference, projectName }
      : {}),
    // One admin. The cash is in someone's hands or it isn't; a second opinion
    // adds nothing but a delay to the member's savings.
    requiredApprovals: 1,
  });

  // SMS as well: nothing is credited until one of these people confirms, and
  // they are usually holding the notes rather than watching their inbox.
  await notifyAll(
    recipients.map((m) => m.userId),
    {
      type: "contribution",
      title: how.noun === "cash" ? `Cash ${label} - confirm receipt` : `${how.noun[0].toUpperCase()}${how.noun.slice(1)} - confirm receipt`,
      body:
        how.noun === "cash"
          ? `${payerName} recorded a K${amount} cash ${label} to ${group.name}. Confirm you received the cash to credit it.`
          : `${payerName} says they ${how.said} for ${group.name}. Confirm it once you see it to credit it.`,
      groupId: group._id,
      groupName: group.name,
      transactionId: txn._id,
      sms: true,
      smsText:
        how.noun === "cash"
          ? `Chuma: ${payerName} says they handed you K${amount} cash for ${group.name}. Confirm it in the app to credit their account.`
          : `Chuma: ${payerName} says they ${how.said} for ${group.name}. Confirm it in the app once you see it.`,
    }
  );

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
          note: `${txn.note} - ${arrival(txn).noun === "cash" ? "cash received" : `${arrival(txn).noun} confirmed`} by ${admin.name}`,
          "meta.cashConfirmedBy": admin.userId,
          "meta.cashConfirmedByName": admin.name,
        }
      : {
          status: "failed",
          note: `${txn.note} - ${arrival(txn).noun} not received (declined by ${admin.name})`,
          "meta.cashConfirmedBy": admin.userId,
          "meta.cashConfirmedByName": admin.name,
        },
    { new: true }
  );
  if (!updated)
    return { error: "Already confirmed or declined", status: 409 };

  if (received) await settleCompletedTransaction(updated);

  // The chairperson is told when cash lands, even though confirming is not
  // their job. Handing over notes is the one movement of group money nobody
  // else witnesses: the member gives, the treasurer confirms, and without this
  // the chairperson learns of it only if they go looking. They are excluded
  // when they are the one who confirmed, or the one who paid - they already
  // know, and an SMS costs credit.
  if (received) {
    const group = await Group.findById(updated.groupId)
      .select("members name")
      .lean();
    const chairs = (group?.members || []).filter(
      (m) =>
        m.status === "active" &&
        m.userId &&
        m.role === "Chairperson" &&
        String(m.userId) !== String(admin.userId) &&
        String(m.userId) !== String(updated.memberId)
    );
    if (chairs.length) {
      const label = labelFor(updated);
      const paid = Math.abs(updated.amount);
      const payer = updated.memberName || "A member";
      await notifyAll(
        chairs.map((m) => m.userId),
        {
          type: "governance",
          title: arrival(updated).noun === "cash" ? `Cash ${label} received` : `${payer}'s ${arrival(updated).noun} confirmed`,
          body:
            arrival(updated).noun === "cash"
              ? `${admin.name} confirmed receiving K${paid} in cash from ${payer}. The money is with them and ${payer}'s account has been credited.`
              : `${admin.name} ${arrival(updated).confirm} of K${paid} from ${payer}. ${payer}'s account has been credited.`,
          groupId: updated.groupId,
          groupName: updated.groupName,
          transactionId: updated._id,
          sms: true,
          smsText:
            arrival(updated).noun === "cash"
              ? `Chuma: ${admin.name} confirmed receiving K${paid} cash from ${payer} for ${updated.groupName}. The money is now with them.`
              : `Chuma: ${admin.name} ${arrival(updated).confirm} of K${paid} from ${payer} for ${updated.groupName}.`,
        }
      );
    }
  }

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

  // Tell the payer either way - a declined receipt is the more urgent of the
  // two, since their money is somewhere and their savings are not.
  if (updated.memberId && String(updated.memberId) !== String(admin.userId)) {
    const label = labelFor(updated);
    const paid = Math.abs(updated.amount);
    const a = arrival(updated);
    const how = {
      noun: a.noun,
      title: a.noun === "cash" ? "Cash" : a.noun[0].toUpperCase() + a.noun.slice(1),
      confirm: a.confirm,
    };
    await notify({
      userId: updated.memberId,
      type: "contribution",
      title: received ? `${how.title} ${label} confirmed` : `${how.title} ${label} declined`,
      body: received
        ? `${admin.name} ${how.confirm} for your K${paid} ${label}. Your account has been updated.`
        : `${admin.name} declined your K${paid} ${how.noun} ${label}. It was not received. Please speak to your treasurer.`,
      groupId: updated.groupId,
      groupName: updated.groupName,
      transactionId: updated._id,
      sms: true,
      smsText: received
        ? `Chuma: ${admin.name} confirmed your K${paid} ${how.noun} ${label}. Your account is updated.`
        : `Chuma: ${admin.name} declined your K${paid} ${how.noun} ${label}. It was not received. Speak to your treasurer.`,
    });
  }

  return { transaction: updated };
}

export default { raiseCashReceipt, resolveCashReceipt, CASH_CONFIRMABLE_TYPES };
