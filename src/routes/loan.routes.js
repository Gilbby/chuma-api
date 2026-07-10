import express from "express";
import { Group } from "../models/Group.js";
import { Loan } from "../models/Loan.js";
import { Approval } from "../models/Approval.js";
import { Transaction } from "../models/Transaction.js";
import { Notification } from "../models/Notification.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth, requireKyc } from "../middleware/auth.js";
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

const router = express.Router();

/**
 * GET /api/loans/eligibility?groupId=...  (auth)
 * Returns the member's borrowing limit and current savings in the group.
 */
router.get(
  "/eligibility",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const savings = req.member.savings || 0;
    const maxLoan = getMaxLoan(savings, req.group.loanMaxMultiplier);
    res.json({
      savings,
      maxLoan,
      multiplier: req.group.loanMaxMultiplier,
      interestRate: req.group.loanInterestRate,
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
  requireKyc,
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

    res.status(201).json({ loan, approval, breakdown });
  })
);

/**
 * POST /api/loans/:id/repay  (auth) — full or partial repayment.
 * Collects from member via PawaPay deposit.
 * Body: { amount, payerPhone? }
 */
router.post(
  "/:id/repay",
  requireAuth,
  requireKyc,
  paymentLimiter,
  asyncHandler(async (req, res) => {
    const { payerPhone } = req.body;
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ error: "Enter a valid amount" });

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
      status: "pending",
      note: "Loan repayment",
      receiptId: generateReceiptId("CHM"),
      meta: { loanId: loan._id },
    });
    await txn.validate(); // ValidationError → 400 via the error middleware

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
