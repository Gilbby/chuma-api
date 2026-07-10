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
import { paymentLimiter } from "../middleware/rateLimits.js";
import { generateReceiptId } from "../utils/helpers.js";
import {
  computePenaltyAmount,
  getRepaymentRate,
  getDefaults,
  getDefaultRate,
  getLoansIssuedThisQuarter,
  getMemberConsistency,
  getSavingsGrowth,
} from "../services/logic.service.js";
import {
  initiateDeposit,
  initiatePayout,
  providerFromPhone,
} from "../services/pawapay.service.js";
import { issuePenalty } from "../services/penalty.service.js";
import { settleCompletedTransaction } from "../services/settlement.service.js";
import { priceContribution, pricePayout } from "../services/pricing.service.js";
import { config } from "../config/index.js";

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
 * POST /api/penalties  (auth, admin) — manually record a violation.
 * For offenses the system can't detect from data (missed meetings,
 * misconduct, …). Creates the penalty + member notification via the same
 * issuePenalty path as automatic detection. Never deduped (no dueContext).
 * Body: { groupId, memberId, violationType, reason, amount }
 */
router.post(
  "/penalties",
  requireAuth,
  requireGroupAdmin("groupId"),
  asyncHandler(async (req, res) => {
    const group = req.group;
    const { memberId, violationType, reason } = req.body;

    const validTypes = Penalty.schema.path("violationType").enumValues;
    if (!validTypes.includes(violationType))
      return res.status(400).json({ error: "Invalid violation type" });

    const member = group.members.find(
      (m) => String(m.userId) === String(memberId) && m.status === "active"
    );
    if (!member)
      return res.status(404).json({ error: "Member not found in this group" });

    const amount = Math.round(Number(req.body.amount));
    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ error: "Amount must be greater than zero" });

    const trimmedReason = String(reason || "").trim();
    if (!trimmedReason)
      return res.status(400).json({ error: "Reason is required" });

    const penalty = await issuePenalty({
      group,
      member,
      violationType,
      reason: trimmedReason,
      amount,
      issuedBy: req.user,
    });

    res.status(201).json({ penalty });
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
  paymentLimiter,
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

    // Validate the full transaction against the model BEFORE initiating the
    // deposit — PawaPay must never move money for a request we would reject.
    const txn = new Transaction({
      groupId: penalty.groupId,
      groupName: penalty.groupName,
      memberId: req.userId,
      memberName: req.user.name,
      type: "penalty",
      amount: -penalty.amount,
      status: "pending",
      note: `Penalty: ${penalty.reason}`,
      receiptId: generateReceiptId("CHM"),
      meta: { penaltyId: penalty._id },
    });
    await txn.validate(); // ValidationError → 400 via the error middleware

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
    txn.pawapay = { depositId: deposit.id, status: deposit.status };
    if (deposit.simulated) txn.status = "completed";
    await txn.save();

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

/**
 * POST /api/penalties/pay  (auth) — pay SEVERAL penalties in ONE deposit.
 *
 * The member picks penalties on the payment screen and pays the total once, so
 * they get a single PawaPay prompt and are charged a single transaction fee.
 * Settlement marks every penalty paid and routes each per its own
 * fundsDestination — see the "penalty" branch of settlement.service.js.
 *
 * All penalties must belong to the SAME group: one deposit produces one
 * transaction, and a transaction belongs to one group.
 */
router.post(
  "/penalties/pay",
  requireAuth,
  paymentLimiter,
  asyncHandler(async (req, res) => {
    const ids = Array.isArray(req.body.penaltyIds) ? req.body.penaltyIds : [];
    if (!ids.length)
      return res.status(400).json({ error: "penaltyIds must be a non-empty array" });
    // Bound the batch: the deposit, the notification and the settlement loop all
    // scale with this, and no member legitimately owes hundreds at once.
    if (ids.length > 20)
      return res.status(400).json({ error: "Cannot pay more than 20 penalties at once" });

    const penalties = await Penalty.find({ _id: { $in: ids } });
    if (penalties.length !== ids.length)
      return res.status(404).json({ error: "One or more penalties not found" });
    if (penalties.some((p) => p.status === "paid"))
      return res.status(400).json({ error: "One or more penalties are already paid" });

    const groupIds = [...new Set(penalties.map((p) => String(p.groupId)))];
    if (groupIds.length > 1)
      return res
        .status(400)
        .json({ error: "All penalties must belong to the same group" });

    // Only the penalised member (or a group admin recording it) can pay. Checked
    // per penalty: a batch must never smuggle in someone else's debt.
    const notMine = penalties.filter((p) => String(p.memberId) !== String(req.userId));
    if (notMine.length) {
      const g = await Group.findById(groupIds[0]).lean();
      if (!g || !isGroupAdmin(g, req.userId))
        return res.status(403).json({ error: "Not your penalty" });
    }

    const total = penalties.reduce((sum, p) => sum + p.amount, 0);
    if (!(total > 0))
      return res.status(400).json({ error: "Nothing to pay" });

    const phone = req.body.payerPhone || req.user.phone;
    const first = penalties[0];

    // Validate the full transaction against the model BEFORE initiating the
    // deposit — PawaPay must never move money for a request we would reject.
    const txn = new Transaction({
      groupId: first.groupId,
      groupName: first.groupName,
      memberId: req.userId,
      memberName: req.user.name,
      type: "penalty",
      amount: -total,
      status: "pending",
      note:
        penalties.length === 1
          ? `Penalty: ${first.reason}`
          : `${penalties.length} penalties`,
      receiptId: generateReceiptId("CHM"),
      meta: { penaltyIds: penalties.map((p) => p._id) },
    });
    await txn.validate(); // ValidationError → 400 via the error middleware

    const deposit = await initiateDeposit({
      amount: total,
      phone,
      provider: providerFromPhone(phone),
      statementDescription: "Chuma penalty",
    });
    if (deposit.status === "REJECTED")
      return res.status(402).json({ error: "Payment rejected" });

    // Penalties are only marked paid (and funds routed) by the settlement
    // service once the payment reaches COMPLETED — inline below for simulated.
    txn.pawapay = { depositId: deposit.id, status: deposit.status };
    if (deposit.simulated) txn.status = "completed";
    await txn.save();

    if (txn.status === "completed") {
      await settleCompletedTransaction(txn);
      const paid = await Penalty.find({ _id: { $in: ids } }).lean();
      return res.json({ message: "Penalties paid", penalties: paid, transaction: txn });
    }

    res.json({
      message: "Penalty payment processing — confirm on your phone",
      penalties,
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

/**
 * POST /api/transactions/:id/retry-payout  (auth, treasurer/chairperson)
 * Re-send a FAILED loan-disbursement or share-out payout. Creates a fresh
 * pending transaction (carrying the original's settlement meta) that settles
 * through the normal webhook/cron path. One retry per failed transaction —
 * claimed atomically so a double-tap can never send the money twice; if the
 * retry itself fails, the NEW failed transaction can be retried in turn.
 */
router.post(
  "/transactions/:id/retry-payout",
  requireAuth,
  paymentLimiter,
  asyncHandler(async (req, res) => {
    const failed = await Transaction.findById(req.params.id);
    if (
      !failed ||
      !["loan", "share-out"].includes(failed.type) ||
      !failed.pawapay?.payoutId
    )
      return res.status(404).json({ error: "Failed payout not found" });
    if (failed.status !== "failed")
      return res
        .status(400)
        .json({ error: "Only failed payouts can be retried" });

    const group = await Group.findById(failed.groupId).lean();
    if (!group) return res.status(404).json({ error: "Group not found" });
    const me = group.members.find(
      (m) => String(m.userId) === String(req.userId) && m.status === "active"
    );
    if (!me || (me.role !== "Treasurer" && me.role !== "Chairperson"))
      return res
        .status(403)
        .json({ error: "Only the treasurer or chairperson can retry payouts" });

    // A disbursement retry only makes sense while the loan is still waiting.
    if (failed.type === "loan" && failed.meta?.loanId) {
      const loan = await Loan.findById(failed.meta.loanId).lean();
      if (!loan) return res.status(404).json({ error: "Loan not found" });
      if (loan.status !== "pending")
        return res
          .status(400)
          .json({ error: `Loan is already ${loan.status} — nothing to disburse` });
    }

    const member = group.members.find(
      (m) => String(m.userId) === String(failed.memberId)
    );
    if (!member?.phone)
      return res.status(400).json({ error: "Member has no phone on record" });

    // A payout draws real money from the merchant float — never resend more
    // than the group's wallet actually holds. The wallet is charged the FULL
    // owed (loan principal / share-out share) at settlement, so cover-check
    // against that, not against the net that goes out the door.
    const owed = Math.abs(failed.amount);
    if (owed > (group.walletBalance || 0))
      return res.status(409).json({
        error: `Group wallet only holds K${group.walletBalance || 0} — it cannot cover this K${owed} payout yet.`,
      });

    // Re-send the EXACT amount that was priced when the original payout was
    // first created — do NOT re-price. depositAmount is what we sent: for a
    // share-out that is owed − fees (re-pricing would deduct fees a SECOND
    // time, paying the member owed − fees − fees); for a loan it is the full
    // principal, since Chuma absorbs the fees there.
    // New txns always carry depositAmount; fall back to `owed` only for OLD
    // failed txns that predate the fee work.
    const sendAmount = failed.depositAmount ?? owed;

    // Claim the failed transaction before sending any money.
    const claimed = await Transaction.findOneAndUpdate(
      { _id: failed._id, status: "failed", "meta.retriedBy": { $exists: false } },
      { "meta.retriedBy": "in-progress" },
      { new: true }
    );
    if (!claimed)
      return res.status(409).json({ error: "This payout was already retried" });

    const payout = await initiatePayout({
      amount: sendAmount,
      phone: member.phone,
      provider: providerFromPhone(member.phone),
      statementDescription:
        failed.type === "loan" ? "Chuma loan" : "Chuma share out",
      metadata: failed.meta?.loanId
        ? [{ fieldName: "loanId", fieldValue: String(failed.meta.loanId) }]
        : [],
    });
    if (payout.status === "REJECTED") {
      // Release the claim so the admin can try again later.
      await Transaction.updateOne(
        { _id: failed._id },
        { $unset: { "meta.retriedBy": "" } }
      );
      return res
        .status(402)
        .json({ error: "Payout rejected", detail: payout.error });
    }

    const baseMeta = { ...(failed.meta || {}) };
    delete baseMeta.retriedBy;
    const retry = await Transaction.create({
      groupId: failed.groupId,
      groupName: failed.groupName,
      memberId: failed.memberId,
      memberName: failed.memberName,
      type: failed.type,
      amount: owed, // positive, full owed — settlement math drives off this
      // Carry the original pricing so THIS retry books platform revenue exactly
      // once when it settles: the original FAILED and never settled/booked, so
      // no PlatformRevenue exists for this economic event yet. depositAmount is
      // the amount actually sent; platformFee (earned) and feesAbsorbed (a cost,
      // booked negative) are booked — guarded per-transactionId by
      // PlatformRevenue's unique index — when the retry settles.
      depositAmount: failed.depositAmount,
      platformFee: failed.platformFee,
      feesAbsorbed: failed.feesAbsorbed,
      status: payout.simulated ? "completed" : "pending",
      note:
        failed.type === "loan" ? "Loan disbursed (retry)" : "Cycle share-out (retry)",
      receiptId: generateReceiptId("CHM"),
      pawapay: { payoutId: payout.id, status: payout.status },
      meta: { ...baseMeta, retryOf: failed._id },
    });
    await Transaction.updateOne(
      { _id: failed._id },
      { "meta.retriedBy": retry._id }
    );

    if (retry.status === "completed") await settleCompletedTransaction(retry);

    res.json({ transaction: retry });
  })
);

/**
 * POST /api/pricing/preview  (auth, member)
 * PURE fee-breakdown calculator — the single source of truth the UI shows
 * BEFORE a member confirms a contribution / share-out / loan. NO side effects:
 * no DB writes, no PawaPay calls, no Transaction. It only runs the same pricing
 * functions the real routes use, with the same config.pricing values, so the
 * preview matches exactly what will be charged.
 * Body: { kind: "contribution" | "payout", amount: number }
 */
router.post(
  "/pricing/preview",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { kind } = req.body || {};
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0)
      return res.status(400).json({ error: "amount must be a finite number > 0" });
    if (kind !== "contribution" && kind !== "payout")
      return res
        .status(400)
        .json({ error: 'kind must be "contribution" or "payout"' });

    if (kind === "contribution") {
      // priceContribution does not throw on small amounts — no tooSmall case.
      const { base, platformFee, depositAmount, feesCovered } = priceContribution(
        {
          base: amount,
          ...config.pricing,
          platformFee: config.pricing.platformFeeFor(amount),
          mnoFee: config.pricing.contributionMnoFee,
          wholeKwachaOnly: config.pricing.contributionWholeKwacha,
        }
      );
      return res.json({ base, platformFee, depositAmount, feesCovered });
    }

    // kind === "payout": pricePayout THROWS when fees meet/exceed the amount
    // (tiny payouts). Surface that as a graceful 200 the UI can render, not a 500.
    try {
      const { owed, platformFee, transactionFee, totalFees, netReceived } =
        pricePayout({ owed: amount, ...config.pricing });
      return res.json({ owed, platformFee, transactionFee, totalFees, netReceived });
    } catch {
      return res.json({ tooSmall: true, reason: "amount too small after fees" });
    }
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
    const contributions = await Transaction.find({
      groupId: group._id,
      type: "contribution",
    }).lean();

    res.json({
      groupId: group._id,
      groupName: group.name,
      repaymentRate: getRepaymentRate(group, loans),
      defaults: getDefaults(group, loans),
      defaultRate: getDefaultRate(loans),
      loansIssuedThisQuarter: getLoansIssuedThisQuarter(loans),
      memberConsistency: getMemberConsistency(group, contributions),
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
