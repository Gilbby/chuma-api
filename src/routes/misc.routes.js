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
import { issuePenalty } from "../services/penalty.service.js";
import { settleCompletedTransaction } from "../services/settlement.service.js";

const router = express.Router();

/**
 * Reconstruct a per-group savings trend from real contribution transactions.
 * Returns the trailing `months` calendar months as a cumulative running total
 * of contributions, matching the frontend chart shape: [{ label, value }].
 * `value` is the raw kwacha cumulative savings for that month (the chart
 * scales itself). New/no-history groups yield a flat zero series of the right
 * length with correct trailing month labels — never mock data.
 */
async function buildSavingsTrend(groupId, months = 6) {
  const txns = await Transaction.find({ groupId, type: "contribution" })
    .sort({ date: 1 })
    .lean();

  const now = new Date();
  // Trailing `months` buckets ending at the current calendar month.
  const buckets = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      year: d.getFullYear(),
      month: d.getMonth(),
      label: d.toLocaleString("en-US", { month: "short" }),
      value: 0,
    });
  }

  const windowStart = new Date(buckets[0].year, buckets[0].month, 1);

  // Contributions before the window seed the opening cumulative total so the
  // first visible month reflects true accumulated savings, not just its own.
  let cumulative = 0;
  const monthlyTotals = new Map(); // "year-month" -> contributions in that month
  for (const t of txns) {
    const td = new Date(t.date);
    const amt = Math.abs(t.amount || 0); // contributions are inflows
    if (td < windowStart) {
      cumulative += amt;
    } else {
      const key = `${td.getFullYear()}-${td.getMonth()}`;
      monthlyTotals.set(key, (monthlyTotals.get(key) || 0) + amt);
    }
  }

  // Running cumulative across the displayed window.
  for (const b of buckets) {
    cumulative += monthlyTotals.get(`${b.year}-${b.month}`) || 0;
    b.value = cumulative;
  }

  return buckets.map((b) => ({ label: b.label, value: b.value }));
}

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

    const daysLate = req.body.daysLate || 1;
    const created = [];

    const make = async (member, type, reason, amount) => {
      const p = await issuePenalty({
        group,
        member,
        violationType: type,
        reason,
        amount,
      });
      if (p) created.push(p);
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

    // Penalty is only marked paid (and funds routed) by the settlement
    // service once the payment reaches COMPLETED — inline below for simulated.
    const txn = await Transaction.create({
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
      meta: { penaltyId: penalty._id },
    });

    if (txn.status === "completed") {
      await settleCompletedTransaction(txn);
      const paid = await Penalty.findById(penalty._id);
      return res.json({ message: "Penalty paid", penalty: paid });
    }

    res.json({
      message: "Penalty payment processing — confirm on your phone",
      penalty,
      transaction: txn,
    });
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
      savingsTrend: await buildSavingsTrend(group._id, 6),
    });
  })
);

/** GET /api/groups/:groupId/savings-trend?months=6 (auth, member) —
 *  cumulative savings trend reconstructed from contribution transactions. */
router.get(
  "/groups/:groupId/savings-trend",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 24);
    const trend = await buildSavingsTrend(req.group._id, months);
    res.json({ trend });
  })
);

export default router;
