import express from "express";
import { v4 as uuidv4 } from "uuid";
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
import {
  settleCompletedTransaction,
  handleFailedTransaction,
} from "../services/settlement.service.js";

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

    // Record the vote ATOMICALLY: it only lands if the approval is still
    // pending and this admin hasn't voted. A read-push-save here lets two
    // concurrent requests (double-tap, or two admins at once) each see a
    // stale vote list — one vote gets clobbered, or worse, both requests
    // reach the execution threshold and disburse real money twice.
    const voted = await Approval.findOneAndUpdate(
      {
        _id: approval._id,
        status: "pending",
        "votes.adminId": { $ne: req.userId },
      },
      {
        $push: {
          votes: { adminId: req.userId, adminName: req.user.name, decision },
        },
      },
      { new: true }
    );
    if (!voted) {
      const fresh = await Approval.findById(approval._id).lean();
      if (
        fresh?.votes?.some((v) => String(v.adminId) === String(req.userId))
      )
        return res.status(400).json({ error: "You already voted" });
      return res.status(400).json({ error: "Approval already resolved" });
    }

    const approves = voted.votes.filter((v) => v.decision === "approve").length;

    let executed = null;
    let result = voted;

    if (decision === "reject") {
      // Any rejection fails sensitive actions in this simple model.
      const claimed = await Approval.findOneAndUpdate(
        { _id: voted._id, status: "pending" },
        { status: "rejected" },
        { new: true }
      );
      if (claimed) {
        result = claimed;
        if (claimed.type === "loan" && claimed.refId)
          await Loan.findByIdAndUpdate(claimed.refId, { status: "rejected" });
      }
    } else if (approves >= voted.requiredApprovals) {
      // Atomic pending→approved claim: exactly ONE request may execute the
      // action behind the approval, no matter how many votes land at once.
      const claimed = await Approval.findOneAndUpdate(
        { _id: voted._id, status: "pending" },
        { status: "approved" },
        { new: true }
      );
      if (claimed) {
        result = claimed;
        executed = await executeApproval(claimed, req);
      }
    }

    res.json({
      approval: result,
      progress: { approves, required: voted.requiredApprovals },
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

    const group = await Group.findById(loan.groupId);
    const member = group?.members.find(
      (m) => String(m.userId) === String(loan.memberId)
    );
    const phone = member?.phone;

    // The payout draws real money from the merchant float — never disburse
    // more than the group's wallet holds (it may have drained since the loan
    // was requested). Record it as a failed, retryable payout so the admins
    // are notified and can retry once contributions/repayments refill it.
    const wallet = group?.walletBalance || 0;
    if (loan.principal > wallet) {
      const txn = await Transaction.create({
        groupId: loan.groupId,
        groupName: loan.groupName,
        memberId: loan.memberId,
        memberName: loan.memberName,
        type: "loan",
        amount: loan.principal,
        status: "failed",
        note: "Loan disbursement blocked — insufficient group wallet",
        receiptId: generateReceiptId("CHM"),
        pawapay: {
          payoutId: uuidv4(), // never sent to PawaPay; keeps retry-payout usable
          status: "REJECTED",
          failureReason: JSON.stringify({
            rejectionReason: "INSUFFICIENT_GROUP_WALLET",
            message: `Group wallet K${wallet} cannot cover the K${loan.principal} loan`,
          }),
        },
        meta: { loanId: loan._id },
      });
      await handleFailedTransaction(txn);
      return {
        type: "loan-disbursement-blocked",
        reason: "insufficient-group-wallet",
        loanId: loan._id,
      };
    }

    // Disburse to the member's wallet via PawaPay payout
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
    //
    // A payout REJECTED at initiation never reaches PawaPay, so no callback
    // or reconciliation will ever finalise it — record it failed immediately
    // (retryable via retry-payout) and notify member + admins like any failure.
    const rejected = payout.status === "REJECTED";
    const txn = await Transaction.create({
      groupId: loan.groupId,
      groupName: loan.groupName,
      memberId: loan.memberId,
      memberName: loan.memberName,
      type: "loan",
      amount: loan.principal, // money in to the member
      status: rejected ? "failed" : payout.simulated ? "completed" : "pending",
      note: "Loan disbursed",
      receiptId: generateReceiptId("CHM"),
      pawapay: {
        payoutId: payout.id,
        status: payout.status,
        ...(rejected ? { failureReason: JSON.stringify(payout.error) } : {}),
      },
      meta: { loanId: loan._id },
    });

    if (rejected) {
      await handleFailedTransaction(txn);
      return { type: "loan-disbursement-rejected", loanId: loan._id, payoutId: payout.id };
    }

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
    try {
      const result = await distributeShareOut(group);
      // One-shot action: mark executed so it can never distribute twice
      await Approval.updateOne({ _id: approval._id }, { status: "executed" });
      approval.status = "executed";
      return {
        type: "share-out-distributed",
        groupId: approval.groupId,
        payouts: result.payouts,
      };
    } catch (err) {
      if (err.status === 409) {
        // Wallet can't cover the pot yet. The approval stays "approved" so an
        // admin can run POST /api/shareout/:groupId/distribute once loans are
        // repaid and the wallet is whole again.
        return { type: "share-out-blocked", reason: err.message };
      }
      throw err;
    }
  }

  return { type: approval.type, note: "Approved (no automated action)" };
}

export default router;
