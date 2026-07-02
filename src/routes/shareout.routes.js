import express from "express";
import { Group } from "../models/Group.js";
import { Penalty } from "../models/Penalty.js";
import { Approval } from "../models/Approval.js";
import { Notification } from "../models/Notification.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import {
  requireGroupMember,
  requireGroupAdmin,
} from "../middleware/groupAuth.js";
import {
  computeShareOut,
  estimateGroupProfit,
  getRequiredApprovals,
  countAdmins,
} from "../services/logic.service.js";
import { distributeShareOut } from "../services/shareout.service.js";

const router = express.Router();

/** Sum paid group-pool penalties in the database instead of loading them all. */
async function getPenaltyIncome(groupId) {
  const [row] = await Penalty.aggregate([
    { $match: { groupId, status: "paid", fundsDestination: "group-pool" } },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  return row?.total || 0;
}

/**
 * GET /api/shareout/:groupId  (auth)
 * Computes the projected share-out for the group from real member savings,
 * loan-interest profit, and penalty income.
 */
router.get(
  "/:groupId",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const group = req.group;
    const penaltyIncome = await getPenaltyIncome(group._id);

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
 * POST /api/shareout/:groupId/propose  (auth)
 * Creates a pending share-out Approval routed to admins instead of paying
 * out immediately. Only one pending share-out approval per group at a time.
 */
router.post(
  "/:groupId/propose",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const group = req.group;
    const existing = await Approval.exists({
      groupId: group._id,
      type: "share-out",
      status: "pending",
    });
    if (existing)
      return res.status(400).json({ error: "Share-out already pending" });

    const penaltyIncome = await getPenaltyIncome(group._id);

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

    const required = getRequiredApprovals(
      group.constitution?.approvalThreshold || "majority",
      countAdmins(group.members)
    );

    const approval = await Approval.create({
      groupId: group._id,
      groupName: group.name,
      type: "share-out",
      title: `Share-out distribution — ${group.name}`,
      description: `Approve end-of-cycle distribution of K${result.totalToDistribute} to members.`,
      amount: result.totalToDistribute,
      requestedById: req.userId,
      requestedBy: req.user.name,
      requiredApprovals: required,
    });

    // Notify admins
    const admins = group.members.filter((m) =>
      ["Chairperson", "Treasurer", "Secretary"].includes(m.role)
    );
    await Notification.insertMany(
      admins
        .filter((a) => a.userId)
        .map((a) => ({
          userId: a.userId,
          type: "governance",
          title: "Share-out approval needed",
          body: `${req.user.name} proposed a share-out of K${result.totalToDistribute} in ${group.name}.`,
          groupId: group._id,
          groupName: group.name,
        }))
    );

    res.status(201).json({ approval });
  })
);

/**
 * POST /api/shareout/:groupId/distribute  (auth, admin)
 * Pays each member their share via PawaPay payout, then resets the cycle.
 * Requires an APPROVED share-out approval, which is atomically consumed
 * (marked executed) so the pot can never be distributed twice.
 */
router.post(
  "/:groupId/distribute",
  requireAuth,
  requireGroupAdmin("groupId"),
  asyncHandler(async (req, res) => {
    const approval = await Approval.findOneAndUpdate(
      { groupId: req.group._id, type: "share-out", status: "approved" },
      { status: "executed" },
      { new: true }
    );
    if (!approval)
      return res.status(403).json({
        error: "Share-out requires an approved proposal. Propose it and collect admin approvals first.",
      });

    const { payouts, summary } = await distributeShareOut(req.group);

    res.json({ message: "Share-out distributed", payouts, summary });
  })
);

export default router;
