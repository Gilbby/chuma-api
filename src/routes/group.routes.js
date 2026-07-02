import express from "express";
import { Group } from "../models/Group.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { Transaction } from "../models/Transaction.js";
import { Approval } from "../models/Approval.js";
import { Loan } from "../models/Loan.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import {
  generateInviteCode,
  generateReceiptId,
  normalizePhone,
} from "../utils/helpers.js";
import {
  getGraceInfo,
  getMonthsOwed,
  getAmountOwed,
  isGroupLocked,
  advancePaidThrough,
  getRepaymentRate,
  getDefaults,
  getSavingsGrowth,
} from "../services/logic.service.js";
import {
  initiateDeposit,
  providerFromPhone,
} from "../services/pawapay.service.js";
import { sendSms } from "../services/sms.service.js";
import config from "../config/index.js";

const router = express.Router();

/** Attach computed fee/lock status to a group object for responses. */
function withFeeStatus(group) {
  const g = group.toObject ? group.toObject() : group;
  const grace = getGraceInfo(g);
  return {
    ...g,
    feeStatus: {
      ...grace,
      monthsOwed: getMonthsOwed(g),
      amountOwed: getAmountOwed(g),
      locked: isGroupLocked(g),
    },
  };
}

/**
 * GET /api/groups  (auth) — groups the user belongs to
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const groups = await Group.find({
      "members.userId": req.userId,
      status: { $ne: "closed" },
    }).lean();
    res.json({ groups: groups.map(withFeeStatus) });
  })
);

/**
 * GET /api/groups/:id  (auth)
 */
router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const group = await Group.findById(req.params.id).lean();
    if (!group) return res.status(404).json({ error: "Group not found" });
    res.json({ group: withFeeStatus(group) });
  })
);

/**
 * POST /api/groups  (auth) — create a group.
 * Charges month 1 of the monthly fee (K100) via PawaPay deposit from the
 * creator's wallet. Group goes live once payment is ACCEPTED.
 *
 * Body: { name, description, groupType, contributionAmount,
 *         contributionFrequency, shareOutDate, loanInterestRate,
 *         loanMaxMultiplier, constitution, payerPhone }
 */
router.post(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = req.body;
    const now = new Date();
    const feeDueDay = now.getDate() > 28 ? 28 : now.getDate();

    // Charge month 1 fee from the creator
    const payerPhone = body.payerPhone || req.user.phone;
    const fee = config.rules.groupMonthlyFee;
    const deposit = await initiateDeposit({
      amount: fee,
      phone: payerPhone,
      provider: providerFromPhone(payerPhone),
      statementDescription: "Chuma group fee",
      metadata: [{ fieldName: "purpose", fieldValue: "group-creation" }],
    });

    if (deposit.status === "REJECTED") {
      return res
        .status(402)
        .json({ error: "Group fee payment was rejected", detail: deposit.error });
    }

    const group = await Group.create({
      name: body.name,
      description: body.description,
      groupType: body.groupType || "savings-group",
      avatar: body.avatar,
      contributionAmount: body.contributionAmount || 0,
      contributionFrequency: body.contributionFrequency || "Monthly",
      shareOutDate: body.shareOutDate ? new Date(body.shareOutDate) : undefined,
      loanInterestRate: body.loanInterestRate ?? 5,
      loanMaxMultiplier: body.loanMaxMultiplier ?? 3,
      constitution: body.constitution || {},
      governance: {
        chairpersonUserId: req.userId,
        treasurerPhone: body.treasurerPhone,
        secretaryPhone: body.secretaryPhone,
      },
      monthlyFee: fee,
      feeDueDay,
      // Paid through one month from now (month 1 covered)
      feePaidThrough: advancePaidThrough({ feePaidThrough: now }, 1),
      inviteCode: generateInviteCode(),
      members: [
        {
          userId: req.userId,
          name: req.user.name,
          phone: req.user.phone,
          role: "Chairperson",
          status: "active",
        },
      ],
      status: "active",
    });

    // Record the fee transaction
    await Transaction.create({
      groupId: group._id,
      groupName: group.name,
      memberId: req.userId,
      memberName: req.user.name,
      type: "fee",
      amount: -fee,
      paymentMethod: undefined,
      status: deposit.simulated ? "completed" : "pending",
      note: "Group registration fee (month 1)",
      receiptId: generateReceiptId("CHF"),
      pawapay: { depositId: deposit.id, status: deposit.status },
    });

    res.status(201).json({ group: withFeeStatus(group) });
  })
);

/**
 * POST /api/groups/:id/invite  (auth) — invite by phone number.
 * Creates a pending member + invite notification + SMS.
 * Body: { phone, role? }
 */
router.post(
  "/:id/invite",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { phone, role = "Member" } = req.body;
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: "Group not found" });

    const normalized = normalizePhone(phone);
    const invited = await User.findOne({ phone: normalized });

    group.members.push({
      userId: invited?._id,
      name: invited?.name || normalized,
      phone: normalized,
      role,
      status: "pending",
    });
    await group.save();

    // Notification (if the invitee already has an account)
    if (invited) {
      await Notification.create({
        userId: invited._id,
        type: "invite",
        title: "Group invitation",
        body: `${req.user.name} invited you to join ${group.name}.`,
        groupId: group._id,
        groupName: group.name,
        invitedBy: req.user.name,
      });
    }

    // SMS invite
    await sendSms(
      normalized,
      `${req.user.name} invited you to join ${group.name} on Chuma. Download the app and use code ${group.inviteCode} to join.`
    );

    res.json({ message: "Invite sent", inviteCode: group.inviteCode });
  })
);

/**
 * POST /api/groups/:id/accept  (auth) — accept a pending invite.
 */
router.post(
  "/:id/accept",
  requireAuth,
  asyncHandler(async (req, res) => {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: "Group not found" });

    const member = group.members.find(
      (m) =>
        (m.userId && String(m.userId) === String(req.userId)) ||
        m.phone === req.user.phone
    );
    if (!member)
      return res.status(404).json({ error: "No invite found for you" });

    member.status = "active";
    member.userId = req.userId;
    member.name = req.user.name;
    await group.save();
    res.json({ message: "Joined group", group: withFeeStatus(group) });
  })
);

/**
 * GET /api/groups/:id/fee  (auth) — fee/lock status + amount owed.
 */
router.get(
  "/:id/fee",
  requireAuth,
  asyncHandler(async (req, res) => {
    const g = await Group.findById(req.params.id).lean();
    if (!g) return res.status(404).json({ error: "Group not found" });
    res.json({
      groupId: g._id,
      groupName: g.name,
      monthlyFee: g.monthlyFee,
      monthsOwed: getMonthsOwed(g),
      amountOwed: getAmountOwed(g),
      grace: getGraceInfo(g),
      locked: isGroupLocked(g),
    });
  })
);

/**
 * POST /api/groups/:id/fee/pay  (auth) — pay outstanding monthly fee(s).
 * Charges via PawaPay deposit from the payer, advances feePaidThrough.
 * Body: { payerPhone? }
 */
router.post(
  "/:id/fee/pay",
  requireAuth,
  asyncHandler(async (req, res) => {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: "Group not found" });

    const g = group.toObject();
    const months = getMonthsOwed(g);
    const amount = getAmountOwed(g);
    if (months <= 0)
      return res.json({ message: "Fee already paid", monthsOwed: 0 });

    const payerPhone = req.body.payerPhone || req.user.phone;
    const deposit = await initiateDeposit({
      amount,
      phone: payerPhone,
      provider: providerFromPhone(payerPhone),
      statementDescription: "Chuma group fee",
      metadata: [{ fieldName: "groupId", fieldValue: String(group._id) }],
    });

    if (deposit.status === "REJECTED") {
      return res
        .status(402)
        .json({ error: "Fee payment rejected", detail: deposit.error });
    }

    group.feePaidThrough = advancePaidThrough(g, months);
    await group.save();

    const txn = await Transaction.create({
      groupId: group._id,
      groupName: group.name,
      memberId: req.userId,
      memberName: req.user.name,
      type: "fee",
      amount: -amount,
      status: deposit.simulated ? "completed" : "pending",
      note: `Group fee — ${months} month(s)`,
      receiptId: generateReceiptId("CHF"),
      pawapay: { depositId: deposit.id, status: deposit.status },
    });

    res.json({
      message: "Group reactivated",
      receipt: {
        receiptId: txn.receiptId,
        amount,
        months,
        paidThrough: group.feePaidThrough,
      },
      group: withFeeStatus(group),
    });
  })
);

/**
 * POST /api/groups/:id/delete-request  (auth) — request group deletion.
 * Blocked if open loans/savings exist. Routes to admin approval.
 */
router.post(
  "/:id/delete-request",
  requireAuth,
  asyncHandler(async (req, res) => {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: "Group not found" });

    const openLoans = await Loan.countDocuments({
      groupId: group._id,
      status: { $in: ["active", "pending", "overdue"] },
    });
    if (openLoans > 0)
      return res.status(400).json({
        error: "Cannot delete: group has open loans. Settle them first.",
      });
    if (group.totalSavings > 0)
      return res.status(400).json({
        error: "Cannot delete: group still holds savings. Share out first.",
      });

    const approval = await Approval.create({
      groupId: group._id,
      groupName: group.name,
      type: "group-deletion",
      title: `Delete ${group.name}`,
      description: req.body.reason || "Group deletion requested",
      requestedById: req.userId,
      requestedBy: req.user.name,
      requiredApprovals: 2,
    });

    group.status = "deletion-pending";
    await group.save();
    res.json({ message: "Deletion requested, pending admin approval", approval });
  })
);

export default router;
