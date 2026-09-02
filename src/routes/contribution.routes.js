import express from "express";
import { Group } from "../models/Group.js";
import { Transaction } from "../models/Transaction.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth, requireRealName } from "../middleware/auth.js";
import { requireGroupMember, isGroupAdmin } from "../middleware/groupAuth.js";
import { paymentLimiter } from "../middleware/rateLimits.js";
import { generateReceiptId } from "../utils/helpers.js";
import { isGroupLocked } from "../services/logic.service.js";
import {
  initiateDeposit,
  providerFromPhone,
} from "../services/pawapay.service.js";
import { settleCompletedTransaction } from "../services/settlement.service.js";
import { priceContribution } from "../services/pricing.service.js";
import {
  raiseCashReceipt,
  resolveCashReceipt,
  CASH_CONFIRMABLE_TYPES,
} from "../services/cashReceipt.service.js";
import { config } from "../config/index.js";

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
  requireRealName,
  paymentLimiter,
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

    // PRICE: split the base (what the member typed = what gets pooled) from the
    // grossed-up total we actually charge. `base` stays the pooled/credited
    // figure; `depositAmount` is what PawaPay collects. Pure math — see
    // pricing.service.js; fee bands come from config so tuning is one file.
    const pricing = priceContribution({
      base: amount,
      platformFee: config.pricing.platformFeeFor(amount),
      pawapayRate: config.pricing.pawapayRate,
      feesOnEndUser: config.pricing.feesOnEndUser,
      mnoFee: config.pricing.collectionFeeFor(providerFromPhone(phone)),
      wholeKwachaOnly: config.pricing.contributionWholeKwacha,
    });
    // Breakdown surfaced to the frontend so it can show the real total charged.
    // networkFee = the member's OWN network charge to their wallet (display-only,
    // not collected by us) — shown on the review tab / receipt.
    const breakdown = {
      base: pricing.base,
      platformFee: pricing.platformFee,
      depositAmount: pricing.depositAmount,
      feesCovered: pricing.feesCovered,
      networkFee: config.pricing.customerFeeFor(providerFromPhone(phone))(amount),
    };

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
      amount: -amount, // BASE (pooled/credited) — money out of the member's wallet
      depositAmount: pricing.depositAmount, // grossed-up total charged to the member
      platformFee: pricing.platformFee, // platform revenue on this txn (never pooled)
      networkFee: isCash ? 0 : breakdown.networkFee, // member's own MMO fee (display-only)
      contributionType,
      paymentMethod,
      status: "pending",
      note: `${contributionType} contribution`,
      receiptId: generateReceiptId("CHM"),
    });
    await txn.validate(); // ValidationError → 400 via the error middleware

    if (!isCash) {
      const deposit = await initiateDeposit({
        amount: pricing.depositAmount, // charge the grossed-up total, not the base
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
      // Nothing is credited until an admin says the money reached them. That
      // acknowledgement is raised as an approval (and a notification to the
      // treasurer), so it is on the group's record like any other decision
      // that moves money.
      const approval = await raiseCashReceipt({
        group,
        txn,
        payerName: req.user.name,
      });
      return res.status(201).json({
        transaction: txn,
        approval,
        pricing: breakdown,
        message: "Recorded — awaiting treasurer confirmation of cash receipt",
      });
    }

    res.status(201).json({ transaction: txn, pricing: breakdown });
  })
);

/**
 * POST /api/contributions/:id/confirm-cash  (auth, group admin)
 * Acknowledge (or decline) physical receipt of a Cash payment.
 * Body: { received?: boolean }  — defaults to true.
 * On confirm: settles the payment and stamps the confirmer's name on it.
 *
 * Handles both a plain Cash contribution and a Cash "combined" payment (the
 * unified checkout — savings + loan repayment(s) + penalties in one lump). Both
 * settle through settleCompletedTransaction, which applies the right effects by
 * transaction type, so this endpoint stays type-agnostic beyond the guard.
 */
router.post(
  "/:id/confirm-cash",
  requireAuth,
  asyncHandler(async (req, res) => {
    const received = req.body?.received !== false;

    const txn = await Transaction.findById(req.params.id);
    if (
      !txn ||
      !CASH_CONFIRMABLE_TYPES.includes(txn.type) ||
      txn.paymentMethod !== "Cash"
    )
      return res.status(404).json({ error: "Cash payment not found" });

    const group = await Group.findById(txn.groupId).lean();
    if (!group) return res.status(404).json({ error: "Group not found" });
    // Any admin of the group, the same set that votes on the approval this
    // receipt was raised as — the two surfaces must not disagree about who is
    // allowed to answer. The treasurer is who gets ASKED (see raiseCashReceipt);
    // a group whose treasurer is away still needs its members credited.
    if (!isGroupAdmin(group, req.userId))
      return res
        .status(403)
        .json({ error: "Only a group admin can confirm cash" });

    const result = await resolveCashReceipt({
      txn,
      admin: { userId: req.userId, name: req.user.name },
      received,
    });
    if (result.error)
      return res.status(result.status).json({ error: result.error });

    res.json({ transaction: result.transaction });
  })
);

export default router;
