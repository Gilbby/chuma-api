import express from "express";
import { Group } from "../models/Group.js";
import { Loan } from "../models/Loan.js";
import { Approval } from "../models/Approval.js";
import { Transaction } from "../models/Transaction.js";
import { Notification } from "../models/Notification.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
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

const router = express.Router();

/**
 * GET /api/loans/eligibility?groupId=...  (auth)
 * Returns the member's borrowing limit and current savings in the group.
 */
router.get(
  "/eligibility",
  requireAuth,
  asyncHandler(async (req, res) => {
    const group = await Group.findById(req.query.groupId);
    if (!group) return res.status(404).json({ error: "Group not found" });
    const member = group.members.find(
      (m) => String(m.userId) === String(req.userId)
    );
    const savings = member?.savings || 0;
    const maxLoan = getMaxLoan(savings, group.loanMaxMultiplier);
    res.json({
      savings,
      maxLoan,
      multiplier: group.loanMaxMultiplier,
      interestRate: group.loanInterestRate,
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
  asyncHandler(async (req, res) => {
    const { groupId, amount, durationMonths, reason } = req.body;
    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ error: "Group not found" });
    if (isGroupLocked(group.toObject()))
      return res.status(423).json({ error: "Group is locked (fee unpaid)" });
    if (!group.constitution?.internalLendingEnabled)
      return res.status(400).json({ error: "Internal lending is disabled" });

    const member = group.members.find(
      (m) => String(m.userId) === String(req.userId)
    );
    const savings = member?.savings || 0;
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
    const { amount, payerPhone } = req.body;
    const loan = await Loan.findById(req.params.id);
    if (!loan) return res.status(404).json({ error: "Loan not found" });
    if (loan.status !== "active" && loan.status !== "overdue")
      return res.status(400).json({ error: "Loan is not active" });

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

    loan.outstanding -= payAmount;
    loan.installmentsPaid += 1;
    loan.history.push({ amount: payAmount, type: "repayment" });
    if (loan.outstanding <= 0) {
      loan.outstanding = 0;
      loan.status = "repaid";
    }
    await loan.save();

    // Reduce group circulation
    const group = await Group.findById(loan.groupId);
    if (group) {
      group.loanCirculation = Math.max(0, group.loanCirculation - payAmount);
      group.walletBalance += payAmount;
      const member = group.members.find(
        (m) => String(m.userId) === String(loan.memberId)
      );
      if (member) member.loanActive = loan.outstanding;
      await group.save();
    }

    const txn = await Transaction.create({
      groupId: loan.groupId,
      groupName: loan.groupName,
      memberId: req.userId,
      memberName: req.user.name,
      type: "repayment",
      amount: -payAmount,
      status: deposit.simulated ? "completed" : "pending",
      note: loan.status === "repaid" ? "Loan fully repaid" : "Loan repayment",
      receiptId: generateReceiptId("CHM"),
      pawapay: { depositId: deposit.id, status: deposit.status },
    });

    res.json({ loan, transaction: txn });
  })
);

/**
 * GET /api/loans?groupId=...  (auth) — loans for a group (or the user).
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const filter = {};
    if (req.query.groupId) filter.groupId = req.query.groupId;
    if (req.query.mine === "true") filter.memberId = req.userId;
    const loans = await Loan.find(filter).sort({ createdAt: -1 });
    res.json({ loans });
  })
);

export default router;
