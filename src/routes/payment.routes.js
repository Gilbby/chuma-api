import express from "express";
import { Loan } from "../models/Loan.js";
import { Penalty } from "../models/Penalty.js";
import { Transaction } from "../models/Transaction.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth, requireRealName } from "../middleware/auth.js";
import { requireGroupMember } from "../middleware/groupAuth.js";
import { paymentLimiter } from "../middleware/rateLimits.js";
import { generateReceiptId } from "../utils/helpers.js";
import { rejectIfMobileMoneyHeld } from "../utils/paymentHold.js";
import { isGroupLocked } from "../services/logic.service.js";
import {
  initiateDeposit,
  providerFromPhone,
} from "../services/pawapay.service.js";
import { settleCompletedTransaction } from "../services/settlement.service.js";
import { raiseCashReceipt } from "../services/cashReceipt.service.js";
import { priceContribution } from "../services/pricing.service.js";
import { config } from "../config/index.js";

const router = express.Router();

const MAX_CHECKOUT = 1_000_000; // ZMW sanity cap on the grand total
const MAX_ITEMS = 20; // per obligation kind — nobody legitimately owes hundreds

/**
 * POST /api/payments/checkout  (auth, member)
 *
 * The unified "pay everything at once" screen. Settles a member's own
 * outstanding obligations in ONE deposit: cycle savings + an optional top-up +
 * any number of loan repayments + any number of penalties, all for the SAME
 * group. The member gets a single PawaPay prompt (or hands the treasurer one
 * lump of cash) and is charged a single transaction fee.
 *
 * The whole grand total is priced ONCE through priceContribution, so the pool /
 * each loan / each penalty each receive their exact face amount and the platform
 * books one fee. Nothing is applied here — the "combined" branch of
 * settlement.service.js splits the deposit into every effect once it COMPLETES
 * (webhook / reconciliation / inline for simulated, or on cash confirmation).
 *
 * Body: {
 *   groupId,
 *   contribution?  (>= 0, cycle savings),
 *   topup?         (>= 0, extra savings above the base),
 *   repayments?    ([{ loanId, amount }]),
 *   penaltyIds?    ([penaltyId]),
 *   paymentMethod  ("MTN MoMo" | "Airtel Money" | "Zamtel Kwacha" | "Cash" | ...),
 *   payerPhone?
 * }
 *
 * Every obligation must belong to the CALLER — this screen pays your own dues.
 * Admin-on-behalf recording stays on the individual routes.
 */
router.post(
  "/checkout",
  requireAuth,
  requireRealName,
  paymentLimiter,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const { groupId, paymentMethod, payerPhone } = req.body;
    const group = req.group;

    if (isGroupLocked(group.toObject()))
      return res.status(423).json({ error: "Group is locked (fee unpaid)" });

    // ── Parse & sanity-check the savings legs ─────────────────────────────────
    const contribution = Number(req.body.contribution) || 0;
    const topup = Number(req.body.topup) || 0;
    if (contribution < 0 || topup < 0)
      return res.status(400).json({ error: "Amounts cannot be negative" });

    // ── Validate loan repayments: caller's own active loans in THIS group ─────
    const rawRepayments = Array.isArray(req.body.repayments)
      ? req.body.repayments
      : [];
    if (rawRepayments.length > MAX_ITEMS)
      return res
        .status(400)
        .json({ error: `Cannot repay more than ${MAX_ITEMS} loans at once` });

    const repayments = [];
    let loanTotal = 0;
    for (const r of rawRepayments) {
      const amount = Number(r?.amount);
      if (!r?.loanId || !Number.isFinite(amount) || amount <= 0)
        return res.status(400).json({ error: "Invalid repayment entry" });

      const loan = await Loan.findById(r.loanId);
      if (!loan) return res.status(404).json({ error: "Loan not found" });
      if (String(loan.groupId) !== String(groupId))
        return res
          .status(400)
          .json({ error: "All obligations must belong to the same group" });
      if (String(loan.memberId) !== String(req.userId))
        return res.status(403).json({ error: "Not your loan" });
      if (loan.status !== "active" && loan.status !== "overdue")
        return res.status(400).json({ error: "Loan is not active" });

      // Never collect more than is owed on the loan.
      const payAmount = Math.min(amount, loan.outstanding);
      if (!(payAmount > 0))
        return res
          .status(400)
          .json({ error: "Nothing outstanding on one of the loans" });
      repayments.push({ loanId: loan._id, amount: payAmount });
      loanTotal += payAmount;
    }

    // ── Validate penalties: caller's own pending penalties in THIS group ──────
    const penaltyIds = Array.isArray(req.body.penaltyIds)
      ? req.body.penaltyIds
      : [];
    if (penaltyIds.length > MAX_ITEMS)
      return res
        .status(400)
        .json({ error: `Cannot pay more than ${MAX_ITEMS} penalties at once` });

    let penaltyTotal = 0;
    let sanitizedPenaltyIds = [];
    if (penaltyIds.length) {
      const penalties = await Penalty.find({ _id: { $in: penaltyIds } });
      if (penalties.length !== penaltyIds.length)
        return res
          .status(404)
          .json({ error: "One or more penalties not found" });
      if (penalties.some((p) => p.status === "paid"))
        return res
          .status(400)
          .json({ error: "One or more penalties are already paid" });
      if (penalties.some((p) => String(p.groupId) !== String(groupId)))
        return res
          .status(400)
          .json({ error: "All obligations must belong to the same group" });
      if (penalties.some((p) => String(p.memberId) !== String(req.userId)))
        return res.status(403).json({ error: "Not your penalty" });
      penaltyTotal = penalties.reduce((sum, p) => sum + p.amount, 0);
      sanitizedPenaltyIds = penalties.map((p) => p._id);
    }

    // ── The grand total: what the member pays in one go ───────────────────────
    const grandBase = contribution + topup + loanTotal + penaltyTotal;
    if (!(grandBase > 0))
      return res.status(400).json({ error: "Nothing to pay" });
    if (grandBase > MAX_CHECKOUT)
      return res.status(400).json({ error: "Amount too large" });

    const phone = payerPhone || req.user.phone;
    const isCash = paymentMethod === "Cash";

    // Mobile money is on hold for member money — the whole checkout is cash.
    const held = rejectIfMobileMoneyHeld(paymentMethod);
    if (held) return res.status(held.status).json(held.body);

    // PRICE the whole total ONCE: `base` (grandBase) is what gets pooled/applied
    // and survives fees; `depositAmount` is what PawaPay collects. Same pure
    // function, config and gross-up the contribution flow uses.
    const pricing = priceContribution({
      base: grandBase,
      ...config.pricing,
      platformFee: config.pricing.platformFeeFor(grandBase),
      mnoFee: config.pricing.collectionFeeFor(providerFromPhone(phone)),
      wholeKwachaOnly: config.pricing.contributionWholeKwacha,
    });
    // Cash is collected at face value: nothing to gross up, and no platform fee
    // we could take out of notes in a treasurer's hand — booking one would
    // record revenue nobody ever received.
    const breakdown = isCash
      ? {
          base: grandBase,
          platformFee: 0,
          depositAmount: grandBase,
          feesCovered: 0,
          networkFee: 0,
        }
      : {
          base: pricing.base,
          platformFee: pricing.platformFee,
          depositAmount: pricing.depositAmount,
          feesCovered: pricing.feesCovered,
          // Member's OWN network charge to their wallet (display-only, not collected).
          networkFee: config.pricing.customerFeeFor(providerFromPhone(phone))(grandBase),
        };

    const parts = [];
    if (contribution > 0) parts.push("savings");
    if (topup > 0) parts.push("top-up");
    if (repayments.length)
      parts.push(
        `${repayments.length} loan repayment${repayments.length > 1 ? "s" : ""}`
      );
    if (sanitizedPenaltyIds.length)
      parts.push(
        `${sanitizedPenaltyIds.length} penalt${
          sanitizedPenaltyIds.length > 1 ? "ies" : "y"
        }`
      );

    // Build and validate the full transaction BEFORE any money moves — PawaPay
    // must never be told to collect for a request our own schema would reject.
    const txn = new Transaction({
      groupId,
      groupName: group.name,
      memberId: req.userId,
      memberName: req.user.name,
      type: "combined",
      amount: -grandBase, // BASE (pooled/applied) — money out of the member
      depositAmount: breakdown.depositAmount, // grossed-up total charged (face value for cash)
      platformFee: breakdown.platformFee, // platform revenue on this txn (never pooled)
      networkFee: breakdown.networkFee, // member's own MMO fee (display-only)
      paymentMethod,
      status: "pending",
      note: `Combined payment: ${parts.join(", ")}`,
      receiptId: generateReceiptId("CHM"),
      meta: {
        contribution,
        topup,
        repayments,
        penaltyIds: sanitizedPenaltyIds,
      },
    });
    await txn.validate(); // ValidationError → 400 via the error middleware

    if (!isCash) {
      const deposit = await initiateDeposit({
        amount: pricing.depositAmount, // charge the grossed-up total, not the base
        phone,
        provider: providerFromPhone(phone),
        statementDescription: "Chuma payment",
        metadata: [{ fieldName: "groupId", fieldValue: String(groupId) }],
      });
      if (deposit.status === "REJECTED")
        return res
          .status(402)
          .json({ error: "Payment rejected", detail: deposit.error });
      txn.pawapay = { depositId: deposit.id, status: deposit.status };
      if (deposit.simulated) txn.status = "completed";
    }

    // Balances/loans/penalties are only touched by the settlement service once
    // the payment reaches COMPLETED — inline below for simulated payments, via
    // the webhook/cron for real ones, or on cash confirmation for Cash.
    await txn.save();

    if (txn.status === "completed") await settleCompletedTransaction(txn);

    if (isCash) {
      // Same receipt flow as a plain cash contribution: an approval for the
      // group's record plus a notification to the treasurer, and nothing is
      // applied — savings, repayments or penalties — until one of them says
      // the money arrived.
      const approval = await raiseCashReceipt({
        group,
        txn,
        payerName: req.user.name,
      });
      return res.status(201).json({
        transaction: txn,
        approval,
        pricing: breakdown,
        message: "Recorded. Awaiting treasurer confirmation of cash receipt",
      });
    }

    res.status(201).json({ transaction: txn, pricing: breakdown });
  })
);

export default router;
