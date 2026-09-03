import express from "express";
import { Group } from "../models/Group.js";
import { Loan } from "../models/Loan.js";
import { Approval } from "../models/Approval.js";
import { Transaction } from "../models/Transaction.js";
import { Notification } from "../models/Notification.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth, requireRealName, hasRealName } from "../middleware/auth.js";
import {
  requireGroupMember,
  isGroupAdmin,
} from "../middleware/groupAuth.js";
import { paymentLimiter } from "../middleware/rateLimits.js";
import { generateReceiptId } from "../utils/helpers.js";
import {
  getMaxLoan,
  getLoanBreakdown,
  checkEligibility,
  getRequiredApprovals,
  countAdmins,
  isGroupLocked,
  getLoanTermConstraints,
} from "../services/logic.service.js";
import {
  initiatePayout,
  initiateDeposit,
  providerFromPhone,
} from "../services/pawapay.service.js";
import { settleCompletedTransaction } from "../services/settlement.service.js";
import { raiseCashReceipt } from "../services/cashReceipt.service.js";
import { rejectIfMobileMoneyHeld } from "../utils/paymentHold.js";
import { pricePayout } from "../services/pricing.service.js";
import { config } from "../config/index.js";

const router = express.Router();

/**
 * GET /api/loans/eligibility?groupId=...  (auth)
 * Returns the member's borrowing limit and current savings in the group, plus
 * every reason they can't borrow at all.
 *
 * The limit alone is not eligibility. POST /loans refuses a request for four
 * further reasons — an unpaid group fee, lending switched off, no real name on
 * the account, an open loan already running — and none of them depend on the
 * amount typed. Reporting them only on submit let a member fill in the whole
 * form and reach the confirm step before being turned away, so they are
 * answered here, in the same order the POST applies them, and the app blocks
 * the flow at the start instead.
 *
 * `walletBalance` is returned rather than judged: whether the group can cover
 * the loan depends on the amount, so the app checks it as they type.
 */
router.get(
  "/eligibility",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const group = req.group;
    const savings = req.member.savings || 0;
    const maxLoan = getMaxLoan(savings, group.loanMaxMultiplier);

    const openLoan = await Loan.exists({
      groupId: group._id,
      memberId: req.userId,
      status: { $in: ["pending", "active", "overdue"] },
    });

    let blocked = null;
    if (!hasRealName(req.user?.name))
      blocked = { code: "needs_name", reason: "Add your name before you can request a loan" };
    else if (isGroupLocked(group.toObject()))
      blocked = { code: "group_locked", reason: "This group is locked until its monthly fee is paid" };
    else if (!group.constitution?.internalLendingEnabled)
      blocked = { code: "lending_disabled", reason: "This group doesn't lend out its savings" };
    else if (openLoan)
      blocked = { code: "open_loan", reason: "You already have an open loan in this group. Repay it first." };
    else if (maxLoan <= 0)
      blocked = { code: "no_savings", reason: "You need savings in this group before you can borrow" };

    res.json({
      savings,
      maxLoan,
      multiplier: group.loanMaxMultiplier,
      interestRate: group.loanInterestRate,
      walletBalance: group.walletBalance || 0,
      canBorrow: !blocked,
      blockedCode: blocked?.code ?? null,
      blockedReason: blocked?.reason ?? null,
    });
  })
);

/**
 * POST /api/loans  (auth) — request a loan.
 * Body: { groupId, amount, durationMonths, reason? }
 * Creates a pending loan + an approval vote routed to admins.
 */
router.post(
  "/",
  requireAuth,
  requireRealName,
  paymentLimiter,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const { groupId, durationMonths, reason } = req.body;
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ error: "Enter a valid amount" });

    const group = req.group;
    if (isGroupLocked(group.toObject()))
      return res.status(423).json({ error: "Group is locked (fee unpaid)" });
    if (!group.constitution?.internalLendingEnabled)
      return res.status(400).json({ error: "Internal lending is disabled" });

    const savings = req.member.savings || 0;
    const maxLoan = getMaxLoan(savings, group.loanMaxMultiplier);
    const elig = checkEligibility(amount, maxLoan);
    if (!elig.eligible) return res.status(400).json({ error: elig.reason });

    // One open loan per member per group: an approved second loan would
    // over-extend the member past the savings-multiple limit.
    const openLoan = await Loan.exists({
      groupId,
      memberId: req.userId,
      status: { $in: ["pending", "active", "overdue"] },
    });
    if (openLoan)
      return res.status(400).json({
        error: "You already have an open loan in this group. Repay it first.",
      });

    // The payout draws real money from the merchant float — never let a group
    // lend more than the cash it actually holds.
    if (amount > (group.walletBalance || 0))
      return res.status(400).json({
        error: `Group wallet only holds K${group.walletBalance || 0} — it cannot cover a K${amount} loan yet.`,
      });

    // A loan must be fully repaid before the cycle closes. Lending stops inside
    // the group's loan-free window near share-out; otherwise the term is capped
    // by BOTH the size tier and the months left until share-out. We clamp an
    // over-long request rather than reject it.
    const term = getLoanTermConstraints(group, amount);
    if (term.lendingClosed)
      return res.status(400).json({
        error: `Lending is closed for this cycle. New loans stop within ${term.windowMonths} month(s) of share-out.`,
      });
    const requested =
      durationMonths || group.constitution?.loanRepaymentMonths || term.maxTerm;
    const months = Math.min(requested, term.maxTerm);
    const breakdown = getLoanBreakdown(amount, group.loanInterestRate, months);

    const loan = await Loan.create({
      groupId,
      groupName: group.name,
      memberId: req.userId,
      memberName: req.user.name,
      principal: amount,
      outstanding: breakdown.totalRepay,
      interestRate: group.loanInterestRate,
      durationMonths: months,
      installmentAmount: breakdown.monthlyInstallment,
      totalInstallments: months,
      reason,
      status: "pending",
      history: [],
    });

    const required = getRequiredApprovals(
      group.constitution?.approvalThreshold || "majority",
      countAdmins(group.members)
    );

    const approval = await Approval.create({
      groupId,
      groupName: group.name,
      type: "loan",
      title: `Loan request — ${req.user.name}`,
      description: reason || `Loan of ${amount}`,
      amount,
      requestedById: req.userId,
      requestedBy: req.user.name,
      refId: loan._id,
      requiredApprovals: required,
    });

    loan.approvalId = approval._id;
    await loan.save();

    // Notify admins
    const admins = group.members.filter((m) =>
      ["Chairperson", "Treasurer", "Secretary"].includes(m.role)
    );
    await Notification.insertMany(
      admins
        .filter((a) => a.userId)
        .map((a) => ({
          userId: a.userId,
          type: "loan",
          title: "Loan approval needed",
          body: `${req.user.name} requested a loan of K${amount} in ${group.name}.`,
          groupId,
          groupName: group.name,
        }))
    );

    // Preview what the borrower will actually RECEIVE at disbursement: all fees
    // (pawaPay % + e-levy + our 1%) are netted out of the principal; they still
    // repay the full loan (breakdown.totalRepay). pricePayout throws on a tiny
    // loan where fees ≥ principal — surface that as `tooSmall`, not a 500.
    let disbursement;
    try {
      const corr = providerFromPhone(req.user.phone || "");
      const p = pricePayout({
        owed: amount,
        platformFee: config.pricing.platformFeeFor(amount),
        pawapayRate: config.pricing.payoutRateFor(corr),
        feesOnEndUser: config.pricing.feesOnEndUser,
        mnoFee: config.pricing.payoutLevyFor(corr),
        wholeKwachaOnly: config.pricing.wholeKwachaOnly,
      });
      disbursement = {
        principal: amount,
        netReceived: p.netReceived,
        transactionFee: p.transactionFee, // pawaPay % + e-levy
        platformFee: p.platformFee, // our 1%
        totalFees: p.totalFees,
      };
    } catch {
      disbursement = { principal: amount, tooSmall: true };
    }

    res.status(201).json({ loan, approval, breakdown, disbursement });
  })
);

/**
 * POST /api/loans/:id/repay  (auth) — full or partial repayment.
 * Collects from the member by PawaPay deposit, or records a cash repayment for
 * an admin to confirm (the only route while the mobile money hold is on).
 * Body: { amount, paymentMethod?, payerPhone? }
 */
router.post(
  "/:id/repay",
  requireAuth,
  requireRealName,
  paymentLimiter,
  asyncHandler(async (req, res) => {
    const { payerPhone, paymentMethod } = req.body;
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ error: "Enter a valid amount" });

    const isCash = paymentMethod === "Cash";
    // Mobile money is on hold for member money — repayments come in as cash.
    const held = rejectIfMobileMoneyHeld(paymentMethod);
    if (held) return res.status(held.status).json(held.body);

    const loan = await Loan.findById(req.params.id);
    if (!loan) return res.status(404).json({ error: "Loan not found" });
    if (loan.status !== "active" && loan.status !== "overdue")
      return res.status(400).json({ error: "Loan is not active" });

    // Only the borrower (or a group admin recording on their behalf) can repay
    if (String(loan.memberId) !== String(req.userId)) {
      const g = await Group.findById(loan.groupId).lean();
      if (!g || !isGroupAdmin(g, req.userId))
        return res.status(403).json({ error: "Not your loan" });
    }

    const payAmount = Math.min(amount, loan.outstanding);
    if (!(payAmount > 0))
      return res.status(400).json({ error: "Nothing outstanding on this loan" });
    const phone = payerPhone || req.user.phone;

    // Validate the full transaction against the model BEFORE initiating the
    // deposit — PawaPay must never move money for a request we would reject.
    const txn = new Transaction({
      groupId: loan.groupId,
      groupName: loan.groupName,
      memberId: req.userId,
      memberName: req.user.name,
      type: "repayment",
      amount: -payAmount,
      paymentMethod,
      status: "pending",
      note: "Loan repayment",
      receiptId: generateReceiptId("CHM"),
      meta: { loanId: loan._id },
    });
    await txn.validate(); // ValidationError → 400 via the error middleware

    // Cash: nothing is applied to the loan until an admin says the money
    // reached them. Same receipt flow as a cash contribution, so the group's
    // record shows who confirmed it — see cashReceipt.service.js.
    if (isCash) {
      const group = await Group.findById(loan.groupId).lean();
      if (!group) return res.status(404).json({ error: "Group not found" });
      await txn.save();
      const approval = await raiseCashReceipt({
        group,
        txn,
        payerName: req.user.name,
      });
      return res.json({
        loan,
        transaction: txn,
        approval,
        message: "Recorded — awaiting an admin's confirmation of the cash",
      });
    }

    const deposit = await initiateDeposit({
      amount: payAmount,
      phone,
      provider: providerFromPhone(phone),
      statementDescription: "Chuma loan repay",
      metadata: [{ fieldName: "loanId", fieldValue: String(loan._id) }],
    });
    if (deposit.status === "REJECTED")
      return res.status(402).json({ error: "Payment rejected" });

    // Loan/group state is only mutated by the settlement service once the
    // payment reaches COMPLETED — inline below for simulated payments.
    txn.pawapay = { depositId: deposit.id, status: deposit.status };
    if (deposit.simulated) txn.status = "completed";
    await txn.save();

    if (txn.status === "completed") {
      await settleCompletedTransaction(txn);
      const settled = await Loan.findById(loan._id);
      return res.json({ loan: settled, transaction: txn });
    }

    res.json({ loan, transaction: txn });
  })
);

/**
 * GET /api/loans?groupId=...&mine=true  (auth) — loans for a group the caller
 * belongs to, or their own loans. Never a global listing.
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.groupId) {
      const g = await Group.findById(String(req.query.groupId))
        .select("members.userId members.status")
        .lean();
      const isMember = g?.members.some(
        (m) => String(m.userId) === String(req.userId) && m.status === "active"
      );
      if (!isMember)
        return res.status(403).json({ error: "Not a member of this group" });
      filter.groupId = req.query.groupId;
      if (req.query.mine === "true") filter.memberId = req.userId;
    } else {
      // Without a group scope, only ever return the caller's own loans
      filter.memberId = req.userId;
    }
    const loans = await Loan.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ loans });
  })
);

export default router;
