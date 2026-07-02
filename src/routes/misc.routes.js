import express from "express";
import { Penalty } from "../models/Penalty.js";
import { Group } from "../models/Group.js";
import { Transaction } from "../models/Transaction.js";
import { Notification } from "../models/Notification.js";
import { Loan } from "../models/Loan.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import {
  requireGroupMember,
  requireGroupAdmin,
  isGroupAdmin,
} from "../middleware/groupAuth.js";
import { generateReceiptId } from "../utils/helpers.js";
import {
  computePenaltyAmount,
  getRepaymentRate,
  getDefaults,
  getSavingsGrowth,
} from "../services/logic.service.js";
import {
  initiateDeposit,
  providerFromPhone,
} from "../services/pawapay.service.js";

const router = express.Router();

// ─── PENALTIES ──────────────────────────────────────────────────────────────

/** GET /api/penalties?mine=true|groupId=... (auth)
 *  Group-scoped requires membership; otherwise only the caller's own. */
router.get(
  "/penalties",
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
      filter.memberId = req.userId;
    }
    const penalties = await Penalty.find(filter).sort({ createdAt: -1 }).lean();
    res.json({ penalties });
  })
);

/**
 * POST /api/penalties/detect/:groupId  (auth, admin)
 * Runs violation detection for a group and creates penalty entries +
 * notifications. In production this is also run by a scheduled job.
 * Body: { overdueMemberIds?, missedMeetingMemberIds?, lateRepaymentLoanIds?,
 *         daysLate? }
 */
router.post(
  "/penalties/detect/:groupId",
  requireAuth,
  requireGroupAdmin("groupId"),
  asyncHandler(async (req, res) => {
    const group = req.group;
    const c = group.constitution;
    if (!c) return res.json({ created: [] });

    const dest = c.penaltyFundsDestination || "group-pool";
    const daysLate = req.body.daysLate || 1;
    const created = [];

    const make = async (member, type, reason, amount) => {
      if (amount <= 0) return;
      const p = await Penalty.create({
        groupId: group._id,
        groupName: group.name,
        memberId: member.userId,
        memberName: member.name,
        violationType: type,
        reason,
        amount,
        fundsDestination: dest,
      });
      if (member.userId) {
        await Notification.create({
          userId: member.userId,
          type: "penalty",
          title: "Penalty issued",
          body: `A ${reason.toLowerCase()} penalty of K${amount} was issued by ${group.name}.`,
          groupId: group._id,
          groupName: group.name,
          penaltyAmount: amount,
          penaltyReason: reason,
        });
      }
      created.push(p);
    };

    // Late contribution
    if (c.penaltyRules?.lateContribution?.enabled) {
      for (const id of req.body.overdueMemberIds || []) {
        const m = group.members.find((x) => String(x.userId) === String(id));
        if (!m) continue;
        const amt = computePenaltyAmount(
          c.penaltyRules.lateContribution,
          group.contributionAmount,
          daysLate
        );
        await make(m, "lateContribution", "Late contribution", amt);
      }
    }
    // Missing meeting
    if (c.penaltyRules?.missingMeeting?.enabled) {
      for (const id of req.body.missedMeetingMemberIds || []) {
        const m = group.members.find((x) => String(x.userId) === String(id));
        if (!m) continue;
        const amt = computePenaltyAmount(c.penaltyRules.missingMeeting, 0, daysLate);
        await make(m, "missingMeeting", "Missing meeting", amt);
      }
    }
    // Late repayment
    if (c.penaltyRules?.lateRepayment?.enabled) {
      for (const loanId of req.body.lateRepaymentLoanIds || []) {
        const loan = await Loan.findById(loanId);
        if (!loan) continue;
        const m = group.members.find(
          (x) => String(x.userId) === String(loan.memberId)
        );
        if (!m) continue;
        const amt = computePenaltyAmount(
          c.penaltyRules.lateRepayment,
          loan.outstanding,
          daysLate
        );
        await make(m, "lateRepayment", "Late loan repayment", amt);
      }
    }

    res.json({ created });
  })
);

/**
 * POST /api/penalties/:id/pay  (auth) — pay a penalty.
 * Collects via PawaPay; routes funds per the group constitution.
 */
router.post(
  "/penalties/:id/pay",
  requireAuth,
  asyncHandler(async (req, res) => {
    const penalty = await Penalty.findById(req.params.id);
    if (!penalty) return res.status(404).json({ error: "Penalty not found" });
    if (penalty.status === "paid")
      return res.status(400).json({ error: "Already paid" });

    // Only the penalised member (or a group admin recording it) can pay
    if (String(penalty.memberId) !== String(req.userId)) {
      const g = await Group.findById(penalty.groupId).lean();
      if (!g || !isGroupAdmin(g, req.userId))
        return res.status(403).json({ error: "Not your penalty" });
    }

    const phone = req.body.payerPhone || req.user.phone;
    const deposit = await initiateDeposit({
      amount: penalty.amount,
      phone,
      provider: providerFromPhone(phone),
      statementDescription: "Chuma penalty",
    });
    if (deposit.status === "REJECTED")
      return res.status(402).json({ error: "Payment rejected" });

    penalty.status = "paid";
    await penalty.save();

    // Route funds: group pool adds to walletBalance/totalSavings
    if (penalty.fundsDestination === "group-pool") {
      await Group.findByIdAndUpdate(penalty.groupId, {
        $inc: { walletBalance: penalty.amount, totalSavings: penalty.amount },
      });
    }
    // emergency-fund / welfare-account would be separate ledgers in production

    await Transaction.create({
      groupId: penalty.groupId,
      groupName: penalty.groupName,
      memberId: req.userId,
      memberName: req.user.name,
      type: "penalty",
      amount: -penalty.amount,
      status: deposit.simulated ? "completed" : "pending",
      note: `Penalty: ${penalty.reason}`,
      receiptId: generateReceiptId("CHM"),
      pawapay: { depositId: deposit.id, status: deposit.status },
    });

    res.json({ message: "Penalty paid", penalty });
  })
);

// ─── NOTIFICATIONS ──────────────────────────────────────────────────────────

/** GET /api/notifications (auth) */
router.get(
  "/notifications",
  requireAuth,
  asyncHandler(async (req, res) => {
    const items = await Notification.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json({ notifications: items });
  })
);

/** PATCH /api/notifications/:id/read (auth) */
router.patch(
  "/notifications/:id/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { read: true }
    );
    res.json({ message: "Marked read" });
  })
);

/** PATCH /api/notifications/read-all (auth) */
router.patch(
  "/notifications/read-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    await Notification.updateMany(
      { userId: req.userId, read: false },
      { read: true }
    );
    res.json({ message: "All marked read" });
  })
);

// ─── TRANSACTIONS ───────────────────────────────────────────────────────────

/** GET /api/transactions?groupId=&type=&range= (auth) */
router.get(
  "/transactions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const filter = { memberId: req.userId };
    if (req.query.groupId) filter.groupId = req.query.groupId;
    if (req.query.type && req.query.type !== "all")
      filter.type = req.query.type;

    if (req.query.range && req.query.range !== "all") {
      const now = Date.now();
      const days =
        req.query.range === "week" ? 7 : req.query.range === "month" ? 30 : 90;
      filter.date = { $gte: new Date(now - days * 24 * 60 * 60 * 1000) };
    }

    const transactions = await Transaction.find(filter)
      .sort({ date: -1 })
      .limit(200)
      .lean();
    res.json({ transactions });
  })
);

/** GET /api/groups/:groupId/transactions?type=&range= (auth)
 *  Group-wide ledger — all members' transactions. Members only. */
router.get(
  "/groups/:groupId/transactions",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const filter = { groupId: req.params.groupId };
    if (req.query.type && req.query.type !== "all") filter.type = req.query.type;
    if (req.query.range && req.query.range !== "all") {
      const now = Date.now();
      const days =
        req.query.range === "week" ? 7 : req.query.range === "month" ? 30 : 90;
      filter.date = { $gte: new Date(now - days * 24 * 60 * 60 * 1000) };
    }

    const transactions = await Transaction.find(filter)
      .sort({ date: -1 })
      .limit(500)
      .lean();
    res.json({ transactions });
  })
);

// ─── REPORTS ────────────────────────────────────────────────────────────────

/** GET /api/reports/:groupId (auth, member) — computed analytics for a group */
router.get(
  "/reports/:groupId",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const group = req.group.toObject();
    const loans = await Loan.find({ groupId: group._id }).lean();

    res.json({
      groupId: group._id,
      groupName: group.name,
      repaymentRate: getRepaymentRate(group, loans),
      defaults: getDefaults(group, loans),
      savingsGrowth: getSavingsGrowth(group),
      totalSavings: group.totalSavings,
      loanCirculation: group.loanCirculation,
      memberRetention: group.memberRetention ?? null,
    });
  })
);

export default router;
