import express from "express";
import { Group } from "../models/Group.js";
import { Transaction } from "../models/Transaction.js";
import { Notification } from "../models/Notification.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { requireGroupMember } from "../middleware/groupAuth.js";
import { generateReceiptId } from "../utils/helpers.js";
import { isGroupLocked } from "../services/logic.service.js";
import {
  initiateDeposit,
  providerFromPhone,
} from "../services/pawapay.service.js";
import { settleCompletedTransaction } from "../services/settlement.service.js";

const router = express.Router();

const MAX_CONTRIBUTION = 1_000_000; // ZMW sanity cap

/**
 * POST /api/contributions  (auth, member)
 * Records a contribution. Collects from the member via PawaPay deposit.
 * Body: { groupId, amount, contributionType ("cycle"|"topup"),
 *         paymentMethod, payerPhone? }
 */
router.post(
  "/",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const { groupId, contributionType = "cycle", paymentMethod, payerPhone } =
      req.body;

    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_CONTRIBUTION)
      return res.status(400).json({ error: "Enter a valid amount" });

    if (!["cycle", "topup"].includes(contributionType))
      return res.status(400).json({ error: "Invalid contribution type" });

    const group = req.group;
    if (isGroupLocked(group.toObject()))
      return res.status(423).json({ error: "Group is locked (fee unpaid)" });

    const phone = payerPhone || req.user.phone;
    const isCash = paymentMethod === "Cash";

    // Build the full transaction and run model validation BEFORE any money
    // moves. PawaPay must never be told to initiate a deposit for a request
    // our own schema would reject (e.g. a bad paymentMethod) — that would
    // leave an orphaned deposit on their side with no record on ours.
    const txn = new Transaction({
      groupId,
      groupName: group.name,
      memberId: req.userId,
      memberName: req.user.name,
      type: "contribution",
      amount: -amount, // money out of the member's wallet
      contributionType,
      paymentMethod,
      status: "pending",
      note: `${contributionType} contribution`,
      receiptId: generateReceiptId("CHM"),
    });
    await txn.validate(); // ValidationError → 400 via the error middleware

    if (!isCash) {
      const deposit = await initiateDeposit({
        amount,
        phone,
        provider: providerFromPhone(phone),
        statementDescription: "Chuma savings",
        metadata: [
          { fieldName: "groupId", fieldValue: String(groupId) },
          { fieldName: "type", fieldValue: contributionType },
        ],
      });
      if (deposit.status === "REJECTED")
        return res
          .status(402)
          .json({ error: "Payment rejected", detail: deposit.error });
      txn.pawapay = { depositId: deposit.id, status: deposit.status };
      if (deposit.simulated) txn.status = "completed";
    }

    // Balances are NOT touched here. Savings/group rollups are applied by the
    // settlement service once the payment settles: PawaPay COMPLETED (webhook
    // or reconciliation cron), inline below for simulated payments, or — for
    // Cash — when the treasurer confirms receipt via POST /:id/confirm-cash.
    await txn.save();

    if (txn.status === "completed") await settleCompletedTransaction(txn);

    if (isCash) {
      // Ask the treasurer (chairperson if the group has none) to acknowledge
      // physically receiving the cash — settlement happens on their confirm.
      const active = group.members.filter((m) => m.status === "active" && m.userId);
      const treasurers = active.filter((m) => m.role === "Treasurer");
      const recipients = treasurers.length
        ? treasurers
        : active.filter((m) => m.role === "Chairperson");
      for (const admin of recipients) {
        await Notification.create({
          userId: admin.userId,
          type: "contribution",
          title: "Cash contribution — confirm receipt",
          body: `${req.user.name} recorded a K${amount} cash contribution to ${group.name}. Confirm you received the cash to credit their savings.`,
          groupId: group._id,
          groupName: group.name,
          transactionId: txn._id,
        });
      }
      return res.status(201).json({
        transaction: txn,
        message: "Recorded — awaiting treasurer confirmation of cash receipt",
      });
    }

    res.status(201).json({ transaction: txn });
  })
);

/**
 * POST /api/contributions/:id/confirm-cash  (auth, treasurer/chairperson)
 * Acknowledge (or decline) physical receipt of a Cash contribution.
 * Body: { received?: boolean }  — defaults to true.
 * On confirm: settles the contribution and stamps the confirmer's name on it.
 */
router.post(
  "/:id/confirm-cash",
  requireAuth,
  asyncHandler(async (req, res) => {
    const received = req.body?.received !== false;

    const txn = await Transaction.findById(req.params.id);
    if (!txn || txn.type !== "contribution" || txn.paymentMethod !== "Cash")
      return res.status(404).json({ error: "Cash contribution not found" });

    const group = await Group.findById(txn.groupId).lean();
    if (!group) return res.status(404).json({ error: "Group not found" });
    const me = group.members.find(
      (m) => String(m.userId) === String(req.userId) && m.status === "active"
    );
    if (!me || (me.role !== "Treasurer" && me.role !== "Chairperson"))
      return res
        .status(403)
        .json({ error: "Only the treasurer or chairperson can confirm cash" });

    // Same atomic pending→final guard as PawaPay settlement: double-taps and
    // a second admin confirming concurrently become harmless no-ops.
    const updated = await Transaction.findOneAndUpdate(
      { _id: txn._id, status: "pending" },
      received
        ? {
            status: "completed",
            note: `${txn.note} — cash received by ${req.user.name}`,
            "meta.cashConfirmedBy": req.userId,
            "meta.cashConfirmedByName": req.user.name,
          }
        : {
            status: "failed",
            note: `${txn.note} — cash not received (declined by ${req.user.name})`,
            "meta.cashConfirmedBy": req.userId,
            "meta.cashConfirmedByName": req.user.name,
          },
      { new: true }
    );
    if (!updated)
      return res.status(409).json({ error: "Already confirmed or declined" });

    if (received) await settleCompletedTransaction(updated);

    if (updated.memberId && String(updated.memberId) !== String(req.userId)) {
      await Notification.create({
        userId: updated.memberId,
        type: "contribution",
        title: received ? "Cash contribution confirmed" : "Cash contribution declined",
        body: received
          ? `${req.user.name} confirmed receiving your K${Math.abs(updated.amount)} cash contribution. Your savings have been updated.`
          : `${req.user.name} declined your K${Math.abs(updated.amount)} cash contribution — the cash was not received. Please speak to your treasurer.`,
        groupId: updated.groupId,
        groupName: updated.groupName,
        transactionId: updated._id,
      });
    }

    res.json({ transaction: updated });
  })
);

export default router;
