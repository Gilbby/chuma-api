import express from "express";
import { Group } from "../models/Group.js";
import { Loan } from "../models/Loan.js";
import { Approval } from "../models/Approval.js";
import { Transaction } from "../models/Transaction.js";
import { Notification } from "../models/Notification.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import {
  requireGroupMember,
  isGroupAdmin,
} from "../middleware/groupAuth.js";
import { generateReceiptId } from "../utils/helpers.js";
import {
  getMaxLoan,
  getLoanBreakdown,
  checkEligibility,
  getRequiredApprovals,
  countAdmins,
  isGroupLocked,
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

    const months = durationMonths || group.constitution?.loanRepaymentMonths || 6;
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
    const phone = payerPhone || req.user.phone;
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
    const txn = await Transaction.create({
      groupId: loan.groupId,
      groupName: loan.groupName,
      memberId: req.userId,
      memberName: req.user.name,
      type: "repayment",
      amount: -payAmount,
      status: deposit.simulated ? "completed" : "pending",
      note: "Loan repayment",
      receiptId: generateReceiptId("CHM"),
      pawapay: { depositId: deposit.id, status: deposit.status },
      meta: { loanId: loan._id },
    });

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
