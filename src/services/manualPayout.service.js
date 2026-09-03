/**
 * Manual payouts — a payout the GROUP settles itself, outside the platform.
 *
 * "Manual" is not "cash". The treasurer might count out notes, send the member
 * mobile money from their own phone, or make a bank transfer; what they all
 * share is that pawaPay never sees it, so nothing will ever call back to say it
 * happened. Only a person can tell us, and until they do the member has not
 * been paid and the app must not claim otherwise.
 *
 * The mirror of cashReceipt.service.js, which does the same job for money
 * coming IN. The rule for what lands here is not the payment method but whether
 * the app can ever learn the answer by itself: a pending payout with pawaPay
 * transfers is settled by the webhook, and one without is settled by a person.
 */
import { Transaction } from "../models/Transaction.js";
import { notify } from "./notify.service.js";
import { settleCompletedTransaction } from "./settlement.service.js";

/** Payout transactions a person can settle by hand. */
export const MANUAL_PAYOUT_TYPES = ["share-out", "loan", "withdrawal"];

const LABELS = {
  "share-out": "share-out",
  loan: "loan",
  withdrawal: "refund",
};

const labelFor = (txn) => LABELS[txn.type] || "payout";

/**
 * True when this transaction is waiting on a person rather than on pawaPay.
 * Anything with transfers in flight belongs to the webhook — confirming it by
 * hand would settle a payout the provider has not actually made.
 */
export function awaitsConfirmation(txn) {
  return (
    !!txn &&
    txn.status === "pending" &&
    MANUAL_PAYOUT_TYPES.includes(txn.type) &&
    !(txn.pawapay?.transfers?.length > 0)
  );
}

/**
 * Record that an admin paid this member. Settling the transaction is what
 * retires their stake / activates their loan, and it is also what tells them:
 * the member hears from us when the money has actually reached them, not when a
 * vote passed.
 *
 * The pending→completed flip is a single atomic update, so two admins marking
 * the same member at once settle it once and the loser is told. There is no
 * decline: an unpaid payout is simply one nobody has confirmed yet, which is
 * exactly what pending already says.
 *
 * `paymentMethod` is optional — how the group chose to move the money. It is
 * recorded on the transaction for the ledger, and changes nothing else.
 *
 * Returns { transaction } on success, or { error, status } to hand back.
 */
export async function confirmManualPayout({ txn, admin, paymentMethod }) {
  if (!MANUAL_PAYOUT_TYPES.includes(txn.type))
    return { error: "This transaction is not a payout", status: 400 };
  if (txn.pawapay?.transfers?.length)
    return {
      error:
        "This payout was sent through the app. It confirms itself once the provider settles it",
      status: 400,
    };

  const updated = await Transaction.findOneAndUpdate(
    { _id: txn._id, status: "pending" },
    {
      status: "completed",
      note: `${txn.note} — paid by ${admin.name}`,
      ...(paymentMethod ? { paymentMethod } : {}),
      "meta.confirmedBy": admin.userId,
      "meta.confirmedByName": admin.name,
      "meta.confirmedAt": new Date(),
    },
    { new: true }
  );
  if (!updated) return { error: "This payout is already marked paid", status: 409 };

  await settleCompletedTransaction(updated);

  // The receipt, and the only message the member gets about this payout. It
  // goes out AFTER the money moved, never before: telling someone to expect
  // money that has not been sent is how a group loses trust in the app.
  if (updated.memberId && String(updated.memberId) !== String(admin.userId)) {
    const label = labelFor(updated);
    const paid = updated.depositAmount ?? Math.abs(updated.amount);
    await notify({
      userId: updated.memberId,
      type: updated.type === "loan" ? "loan" : "governance",
      title: `${label[0].toUpperCase()}${label.slice(1)} payout complete`,
      body: `Your K${paid} ${label} from ${updated.groupName} has been paid. Marked complete by ${admin.name}. Receipt ${updated.receiptId}.`,
      groupId: updated.groupId,
      groupName: updated.groupName,
      transactionId: updated._id,
      sms: true,
      smsText: `Chuma: Your K${paid} ${label} from ${updated.groupName} is complete. Receipt ${updated.receiptId}.`,
    });
  }

  return { transaction: updated };
}

export default { confirmManualPayout, awaitsConfirmation, MANUAL_PAYOUT_TYPES };
