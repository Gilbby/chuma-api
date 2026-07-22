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
import { pricePayout } from "../services/pricing.service.js";
import { config } from "../config/index.js";
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

    // Price the disbursement FIRST (pure, no side effects). The borrower bears
    // the fees: pawaPay % + e-levy + our 1% are netted OUT of the principal, so
    // they RECEIVE principal − fees but REPAY the full loan (outstanding, fixed
    // at request). pricePayout THROWS when fees meet/exceed the principal (a tiny
    // loan) — record that blocked rather than crash the approval executor.
    const correspondent = providerFromPhone(phone || "");
    let priced;
    try {
      priced = pricePayout({
        owed: loan.principal,
        platformFee: config.pricing.platformFeeFor(loan.principal), // our 1%, netted out
        pawapayRate: config.pricing.payoutRateFor(correspondent), // 1% Airtel / 2% MTN & Zamtel
        feesOnEndUser: config.pricing.feesOnEndUser,
        mnoFee: config.pricing.payoutLevyFor(correspondent), // e-levy on MTN payouts only
        wholeKwachaOnly: config.pricing.wholeKwachaOnly,
      });
    } catch {
      // A pricing failure is permanent (re-pricing fails the same way) — not
      // retryable, so no transfers to re-send.
      const txn = await Transaction.create({
        groupId: loan.groupId,
        groupName: loan.groupName,
        memberId: loan.memberId,
        memberName: loan.memberName,
        type: "loan",
        amount: loan.principal,
        status: "failed",
        note: "Loan disbursement blocked — fees meet or exceed the principal",
        receiptId: generateReceiptId("CHM"),
        pawapay: {
          payoutId: uuidv4(),
          status: "REJECTED",
          failureReason: JSON.stringify({
            rejectionReason: "PAYOUT_PRICING_FAILED",
            message: `Fees meet or exceed the K${loan.principal} principal — cannot disburse`,
          }),
        },
        meta: { loanId: loan._id },
      });
      await handleFailedTransaction(txn);
      return {
        type: "loan-disbursement-blocked",
        reason: "payout-pricing-failed",
        loanId: loan._id,
      };
    }

    // The payout draws real money from the merchant float — never disburse when
    // the wallet can't cover the principal (it decrements by the full principal
    // at settlement, and may have drained since the loan was requested). Record a
    // failed, RETRYABLE payout (one rejected transfer of the net amount) so admins
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
        depositAmount: priced.netReceived,
        platformFee: priced.platformFee,
        status: "failed",
        note: "Loan disbursement blocked — insufficient group wallet",
        receiptId: generateReceiptId("CHM"),
        pawapay: {
          status: "REJECTED",
          transfers: [
            {
              payoutId: uuidv4(), // never sent to PawaPay; retry re-sends this transfer
              amount: priced.netReceived,
              status: "REJECTED",
              failureReason: JSON.stringify({
                rejectionReason: "INSUFFICIENT_GROUP_WALLET",
                message: `Group wallet K${wallet} cannot cover the K${loan.principal} loan`,
              }),
            },
          ],
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

    // Disburse the NET (principal − fees) to the member's wallet via PawaPay.
    const payout = await initiatePayout({
      amount: priced.netReceived,
      phone,
      provider: correspondent,
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
      amount: loan.principal, // full principal — drives circulation/wallet math and repayment
      depositAmount: priced.netReceived, // NET the borrower received (principal − fees)
      platformFee: priced.platformFee, // our 1%, earned (netted out of the principal)
      status: rejected ? "failed" : payout.simulated ? "completed" : "pending",
      note: "Loan disbursed",
      receiptId: generateReceiptId("CHM"),
      pawapay: {
        transfers: payout.transfers, // ≥1 transfer; parent settles when all COMPLETE
        status: payout.status,
      },
      meta: { loanId: loan._id },
    });

    if (rejected) {
      await handleFailedTransaction(txn);
      return {
        type: "loan-disbursement-rejected",
        loanId: loan._id,
        payoutId: payout.transfers[0]?.payoutId,
      };
    }

    if (loan.memberId) {
      await Notification.create({
        userId: loan.memberId,
        type: "loan",
        title: "Loan approved",
        body: `Your loan of K${loan.principal} is approved and is on its way to your wallet.`,
        groupId: loan.groupId,
        groupName: loan.groupName,
      });
    }

    if (txn.status === "completed") {
      await settleCompletedTransaction(txn);
      return {
        type: "loan-disbursed",
        loanId: loan._id,
        payoutId: payout.transfers[0]?.payoutId,
      };
    }

    return {
      type: "loan-disbursement-initiated",
      loanId: loan._id,
      payoutId: payout.transfers[0]?.payoutId,
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
