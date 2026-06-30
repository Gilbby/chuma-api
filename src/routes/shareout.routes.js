import express from "express";
import { Group } from "../models/Group.js";
import { Penalty } from "../models/Penalty.js";
import { Transaction } from "../models/Transaction.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { generateReceiptId } from "../utils/helpers.js";
import {
  computeShareOut,
  estimateGroupProfit,
} from "../services/logic.service.js";
import {
  initiatePayout,
  providerFromPhone,
} from "../services/pawapay.service.js";

const router = express.Router();

/**
 * GET /api/shareout/:groupId  (auth)
 * Computes the projected share-out for the group from real member savings,
 * loan-interest profit, and penalty income.
 */
router.get(
  "/:groupId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ error: "Group not found" });

    const penaltyIncome = await Penalty.find({
      groupId: group._id,
      status: "paid",
      fundsDestination: "group-pool",
    }).then((ps) => ps.reduce((s, p) => s + p.amount, 0));

    const cycleMonths = group.constitution?.loanRepaymentMonths || 12;
    const profit = estimateGroupProfit(
      group.loanCirculation || 0,
      group.loanInterestRate || 0,
      cycleMonths,
      penaltyIncome
    );

    const members = group.members
      .filter((m) => m.status === "active")
      .map((m) => ({
        id: String(m.userId || m._id),
        name: m.name,
        contribution: m.savings,
      }));

    const result = computeShareOut(members, profit);

    res.json({
      groupId: group._id,
      groupName: group.name,
      shareOutDate: group.shareOutDate,
      penaltyIncome,
      ...result,
    });
  })
);

/**
 * POST /api/shareout/:groupId/distribute  (auth, chairperson)
 * Pays each member their share via PawaPay payout, then resets the cycle.
 * (In production, gate this behind an approved share-out approval.)
 */
router.post(
  "/:groupId/distribute",
  requireAuth,
  asyncHandler(async (req, res) => {
    const group = await Group.findById(req.params.groupId);
    if (!group) return res.status(404).json({ error: "Group not found" });

    const penaltyIncome = await Penalty.find({
      groupId: group._id,
      status: "paid",
      fundsDestination: "group-pool",
    }).then((ps) => ps.reduce((s, p) => s + p.amount, 0));

    const cycleMonths = group.constitution?.loanRepaymentMonths || 12;
    const profit = estimateGroupProfit(
      group.loanCirculation || 0,
      group.loanInterestRate || 0,
      cycleMonths,
      penaltyIncome
    );

    const activeMembers = group.members.filter((m) => m.status === "active");
    const members = activeMembers.map((m) => ({
      id: String(m.userId || m._id),
      name: m.name,
      contribution: m.savings,
    }));
    const result = computeShareOut(members, profit);

    // Pay each member their share
    const payouts = [];
    for (const m of activeMembers) {
      const calc = result.members.find(
        (r) => r.id === String(m.userId || m._id)
      );
      if (!calc || calc.share <= 0) continue;
      const payout = await initiatePayout({
        amount: calc.share,
        phone: m.phone,
        provider: providerFromPhone(m.phone || ""),
        statementDescription: "Chuma share-out",
      });
      await Transaction.create({
        groupId: group._id,
        groupName: group.name,
        memberId: m.userId,
        memberName: m.name,
        type: "share-out",
        amount: calc.share,
        status: payout.simulated ? "completed" : "pending",
        note: "Cycle share-out",
        receiptId: generateReceiptId("CHM"),
        pawapay: { payoutId: payout.id, status: payout.status },
      });
      payouts.push({ member: m.name, amount: calc.share, payoutId: payout.id });
    }

    // Reset cycle: zero member savings + group pool, start a new cycle
    group.members.forEach((m) => {
      m.savings = 0;
      m.contributions = 0;
    });
    group.totalSavings = 0;
    group.cycleProgress = 0;
    await group.save();

    res.json({ message: "Share-out distributed", payouts, summary: result });
  })
);

export default router;
