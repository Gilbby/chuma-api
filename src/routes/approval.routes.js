import express from "express";
import { Approval } from "../models/Approval.js";
import { Loan } from "../models/Loan.js";
import { Group } from "../models/Group.js";
import { Transaction } from "../models/Transaction.js";
import { Notification } from "../models/Notification.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { isGroupAdmin } from "../middleware/groupAuth.js";
import { generateReceiptId } from "../utils/helpers.js";
import {
  initiatePayout,
  providerFromPhone,
} from "../services/pawapay.service.js";
import { distributeShareOut } from "../services/shareout.service.js";
import { settleCompletedTransaction } from "../services/settlement.service.js";

const router = express.Router();

/**
 * GET /api/approvals?groupId=...  (auth) — pending approvals, scoped to
 * groups the caller belongs to (never a global listing).
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const myGroups = await Group.find({
      members: { $elemMatch: { userId: req.userId, status: "active" } },
    })
      .select("_id")
      .lean();
    const myGroupIds = myGroups.map((g) => g._id);

    const filter = { status: "pending", groupId: { $in: myGroupIds } };
    if (req.query.groupId) {
      const requested = String(req.query.groupId);
      if (!myGroupIds.some((id) => String(id) === requested))
        return res.status(403).json({ error: "Not a member of this group" });
      filter.groupId = requested;
    }
    const approvals = await Approval.find(filter).sort({ createdAt: -1 });
    res.json({ approvals });
  })
);

/**
 * POST /api/approvals/:id/vote  (auth)
 * Body: { decision: "approve" | "reject" }
 * Records the admin's vote. When the threshold is met, executes the action
 * (e.g. disburse a loan via PawaPay payout).
 */
router.post(
  "/:id/vote",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { decision } = req.body;
    if (!["approve", "reject"].includes(decision))
      return res.status(400).json({ error: "Decision must be approve or reject" });

    const approval = await Approval.findById(req.params.id);
    if (!approval) return res.status(404).json({ error: "Approval not found" });
    if (approval.status !== "pending")
      return res.status(400).json({ error: "Approval already resolved" });

    // Only admins of the approval's group may vote
    const group = await Group.findById(approval.groupId).lean();
    if (!group || !isGroupAdmin(group, req.userId))
      return res
        .status(403)
        .json({ error: "Only group admins can vote on approvals" });

    // Prevent double-voting
    if (approval.votes.some((v) => String(v.adminId) === String(req.userId)))
      return res.status(400).json({ error: "You already voted" });

    approval.votes.push({
      adminId: req.userId,
      adminName: req.user.name,
      decision,
    });

    const approves = approval.votes.filter((v) => v.decision === "approve").length;
    const rejects = approval.votes.filter((v) => v.decision === "reject").length;

    let executed = null;

    if (rejects > 0 && decision === "reject") {
      // Any rejection fails sensitive actions in this simple model
      approval.status = "rejected";
      if (approval.type === "loan" && approval.refId) {
        await Loan.findByIdAndUpdate(approval.refId, { status: "rejected" });
      }
    } else if (approves >= approval.requiredApprovals) {
      approval.status = "approved";
      executed = await executeApproval(approval, req);
    }

    await approval.save();
    res.json({
      approval,
      progress: { approves, required: approval.requiredApprovals },
      executed,
    });
  })
);

/**
 * Execute the action behind an approved approval.
 */
async function executeApproval(approval, req) {
  if (approval.type === "loan" && approval.refId) {
    const loan = await Loan.findById(approval.refId);
    if (!loan) return null;

    // Disburse to the member's wallet via PawaPay payout
    const member = await Group.findById(loan.groupId).then((g) =>
      g?.members.find((m) => String(m.userId) === String(loan.memberId))
    );
    const phone = member?.phone;
    const payout = await initiatePayout({
      amount: loan.principal,
      phone,
      provider: providerFromPhone(phone || ""),
      statementDescription: "Chuma loan",
      metadata: [{ fieldName: "loanId", fieldValue: String(loan._id) }],
    });

    // The loan stays "pending" until the payout reaches COMPLETED — the
    // settlement service then activates it, updates group circulation and
    // notifies the member. Inline below for simulated payouts.
    const txn = await Transaction.create({
      groupId: loan.groupId,
      groupName: loan.groupName,
      memberId: loan.memberId,
      memberName: loan.memberName,
      type: "loan",
      amount: loan.principal, // money in to the member
      status: payout.simulated ? "completed" : "pending",
      note: "Loan disbursed",
      receiptId: generateReceiptId("CHM"),
      pawapay: { payoutId: payout.id, status: payout.status },
      meta: { loanId: loan._id },
    });

    if (loan.memberId) {
      await Notification.create({
        userId: loan.memberId,
        type: "loan",
        title: "Loan approved",
        body: `Your loan of K${loan.principal} has been approved. The money is on its way to your wallet.`,
        groupId: loan.groupId,
        groupName: loan.groupName,
      });
    }

    if (txn.status === "completed") {
      await settleCompletedTransaction(txn);
      return { type: "loan-disbursed", loanId: loan._id, payoutId: payout.id };
    }

    return {
      type: "loan-disbursement-initiated",
      loanId: loan._id,
      payoutId: payout.id,
    };
  }

  if (approval.type === "group-deletion" && approval.groupId) {
    await Group.findByIdAndUpdate(approval.groupId, { status: "closed" });
    return { type: "group-closed", groupId: approval.groupId };
  }

  if (approval.type === "share-out" && approval.groupId) {
    const group = await Group.findById(approval.groupId);
    if (!group) return null;
    const result = await distributeShareOut(group);
    // One-shot action: mark executed so it can never distribute twice
    approval.status = "executed";
    return {
      type: "share-out-distributed",
      groupId: approval.groupId,
      payouts: result.payouts,
    };
  }

  return { type: approval.type, note: "Approved (no automated action)" };
}

export default router;
