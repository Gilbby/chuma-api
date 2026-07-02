import express from "express";
import { Group } from "../models/Group.js";
import { Transaction } from "../models/Transaction.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { requireGroupMember } from "../middleware/groupAuth.js";
import { generateReceiptId } from "../utils/helpers.js";
import { isGroupLocked } from "../services/logic.service.js";
import {
  initiateDeposit,
  providerFromPhone,
} from "../services/pawapay.service.js";

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

    const group = req.group;
    if (isGroupLocked(group.toObject()))
      return res.status(423).json({ error: "Group is locked (fee unpaid)" });

    const phone = payerPhone || req.user.phone;
    let deposit = { id: undefined, status: "ACCEPTED", simulated: true };

    // Cash is recorded by an admin; no PawaPay call
    if (paymentMethod !== "Cash") {
      deposit = await initiateDeposit({
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
    }

    // Update member's savings + group rollup atomically ($inc avoids the
    // read-modify-write race when members contribute at the same time).
    // Membership is guaranteed by requireGroupMember.
    await Group.updateOne(
      { _id: groupId, "members.userId": req.userId },
      {
        $inc: {
          "members.$.savings": amount,
          "members.$.contributions": 1,
          totalSavings: amount,
          walletBalance: amount,
        },
      }
    );

    const txn = await Transaction.create({
      groupId,
      groupName: group.name,
      memberId: req.userId,
      memberName: req.user.name,
      type: "contribution",
      amount: -amount, // money out of the member's wallet
      contributionType,
      paymentMethod,
      status: deposit.simulated || paymentMethod === "Cash" ? "completed" : "pending",
      note: `${contributionType} contribution`,
      receiptId: generateReceiptId("CHM"),
      pawapay: { depositId: deposit.id, status: deposit.status },
    });

    res.status(201).json({ transaction: txn });
  })
);

export default router;
