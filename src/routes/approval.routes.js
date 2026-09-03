import express from "express";
import { v4 as uuidv4 } from "uuid";
import { Approval } from "../models/Approval.js";
import { Loan } from "../models/Loan.js";
import { Group } from "../models/Group.js";
import { Transaction } from "../models/Transaction.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { isGroupAdmin, ADMIN_ROLES } from "../middleware/groupAuth.js";
import { generateReceiptId } from "../utils/helpers.js";
import { isMobileMoneyOnHold } from "../utils/paymentHold.js";
import {
  initiatePayout,
  providerFromPhone,
} from "../services/pawapay.service.js";
import { pricePayout } from "../services/pricing.service.js";
import { notify } from "../services/notify.service.js";
import { config } from "../config/index.js";
import { distributeShareOut } from "../services/shareout.service.js";
import { resolveCashReceipt } from "../services/cashReceipt.service.js";
import { refundAndRemoveMember } from "../services/memberExit.service.js";
import {
  settleCompletedTransaction,
  handleFailedTransaction,
} from "../services/settlement.service.js";

const router = express.Router();

// Everything that is no longer waiting on a vote — the approval history.
const RESOLVED_STATUSES = ["approved", "rejected", "executed"];

/**
 * GET /api/approvals?groupId=...&status=...&limit=...  (auth) — approvals
 * scoped to groups the caller belongs to (never a global listing).
 *
 * status: "pending" (default), "resolved" (the history: approved, rejected,
 * executed), "all", or one exact status. Pending stays the default because
 * most callers only want the work queue — history is opt-in.
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const wanted = String(req.query.status || "pending");
    let status;
    if (wanted === "all") status = null;
    else if (wanted === "resolved") status = { $in: RESOLVED_STATUSES };
    else if (["pending", ...RESOLVED_STATUSES].includes(wanted)) status = wanted;
    else return res.status(400).json({ error: "Unknown status filter" });

    // History grows without bound — cap it so a long-lived group still fits in
    // one reasonable response.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);

    const myGroups = await Group.find({
      members: { $elemMatch: { userId: req.userId, status: "active" } },
    })
      .select("_id")
      .lean();
    const myGroupIds = myGroups.map((g) => g._id);

    const filter = { groupId: { $in: myGroupIds } };
    if (status) filter.status = status;
    if (req.query.groupId) {
      const requestedGroup = String(req.query.groupId);
      if (!myGroupIds.some((id) => String(id) === requestedGroup))
        return res.status(403).json({ error: "Not a member of this group" });
      filter.groupId = requestedGroup;
    }
    const approvals = await Approval.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit);
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

    // An admin facing removal keeps their vote everywhere EXCEPT on their own
    // removal — otherwise the person being removed decides it. The quorum was
    // sized without them (see the remove route), so this only closes the door.
    if (
      approval.type === "member-removal" &&
      approval.targetUserId &&
      String(approval.targetUserId) === String(req.userId)
    )
      return res
        .status(403)
        .json({ error: "You cannot vote on your own removal" });

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
        // Rejecting a cash receipt means the money never arrived: fail the
        // transaction and tell the member, exactly as declining from the
        // notification does.
        if (claimed.type === "cash-receipt" && claimed.refId) {
          const txn = await Transaction.findById(claimed.refId);
          if (txn)
            await resolveCashReceipt({
              txn,
              admin: {
                userId: req.userId,
                name: req.user.name,
                skipApproval: true,
              },
              received: false,
            });
        }
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
 * POST /api/approvals/:id/execute  (auth, group admin) — re-run an approval
 * whose vote carried but whose action could not complete at the time (a refund
 * the wallet couldn't cover yet, say). The votes stand; only the action runs.
 */
router.post(
  "/:id/execute",
  requireAuth,
  asyncHandler(async (req, res) => {
    const approval = await Approval.findById(req.params.id);
    if (!approval) return res.status(404).json({ error: "Approval not found" });

    const group = await Group.findById(approval.groupId).lean();
    if (!group || !isGroupAdmin(group, req.userId))
      return res.status(403).json({ error: "Only group admins can run this" });

    if (approval.status === "executed")
      return res.status(400).json({ error: "Already carried out" });
    if (approval.status !== "approved")
      return res
        .status(400)
        .json({ error: "Only an approved action can be run" });

    // Claim it first: two admins tapping "run again" at once must not refund or
    // disburse twice. The claim is released below if the action is still blocked.
    const claimed = await Approval.findOneAndUpdate(
      { _id: approval._id, status: "approved" },
      { status: "executed" },
      { new: true }
    );
    if (!claimed)
      return res.status(409).json({ error: "Already being carried out" });

    let executed;
    try {
      executed = await executeApproval(claimed, req);
    } catch (err) {
      await Approval.updateOne({ _id: claimed._id }, { status: "approved" });
      throw err;
    }
    // Still blocked — hand the approval back so it can be run again later.
    if (executed?.type?.endsWith("-blocked")) {
      await Approval.updateOne({ _id: claimed._id }, { status: "approved" });
      return res.status(409).json({ error: executed.reason, executed });
    }

    res.json({ approval: await Approval.findById(claimed._id), executed });
  })
);

/**
 * Execute the action behind an approved approval.
 */
async function executeApproval(approval, req) {
  // A cash receipt approved: the admin has the money, so settle the payment
  // that has been sitting pending since it was recorded. resolveCashReceipt is
  // the same path the notification's confirm button takes, and its atomic
  // status flip makes a race between the two surfaces harmless.
  if (approval.type === "cash-receipt" && approval.refId) {
    const txn = await Transaction.findById(approval.refId);
    if (!txn) return null;
    const result = await resolveCashReceipt({
      txn,
      admin: { userId: req.userId, name: req.user.name, skipApproval: true },
      received: true,
    });
    return {
      type: "cash-receipt",
      settled: !result.error,
      transactionId: approval.refId,
      ...(result.error ? { reason: result.error } : {}),
    };
  }

  if (approval.type === "loan" && approval.refId) {
    const loan = await Loan.findById(approval.refId);
    if (!loan) return null;

    const group = await Group.findById(loan.groupId);
    const member = group?.members.find(
      (m) => String(m.userId) === String(loan.memberId)
    );
    const phone = member?.phone;

    // ── Mobile money on hold: disburse as CASH ──────────────────────────────
    // The treasurer hands the borrower the notes. Nothing is netted out — there
    // is no pawaPay fee on cash, and we cannot take our 1% out of a cash box —
    // so the borrower receives the full principal and repays what the loan
    // already says. The wallet guard still applies: a group cannot hand out
    // money it does not hold.
    if (isMobileMoneyOnHold()) {
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
          paymentMethod: "Cash",
          meta: { loanId: loan._id },
        });
        await handleFailedTransaction(txn);
        return {
          type: "loan-disbursement-blocked",
          reason: "insufficient-group-wallet",
          loanId: loan._id,
        };
      }

      const txn = await Transaction.create({
        groupId: loan.groupId,
        groupName: loan.groupName,
        memberId: loan.memberId,
        memberName: loan.memberName,
        type: "loan",
        amount: loan.principal, // full principal — drives circulation and repayment
        depositAmount: loan.principal, // handed over in full: no fees on cash
        platformFee: 0, // nothing to take out of notes we never touch
        paymentMethod: "Cash",
        status: "completed",
        note: "Loan disbursed in cash",
        receiptId: generateReceiptId("CHM"),
        meta: { loanId: loan._id, cashDisbursement: true },
      });
      // Activates the loan, moves the principal into circulation and tells the
      // borrower to collect from the treasurer — the same settlement path a
      // completed payout takes.
      await settleCompletedTransaction(txn);

      return {
        type: "loan-disbursed-cash",
        loanId: loan._id,
        amount: loan.principal,
        transactionId: txn._id,
      };
    }

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
            message: `Fees meet or exceed the K${loan.principal} principal. Cannot disburse`,
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
      await notify({
        userId: loan.memberId,
        type: "loan",
        title: "Loan approved",
        body: `Your loan of K${loan.principal} is approved and is on its way to your wallet.`,
        groupId: loan.groupId,
        groupName: loan.groupName,
        // The outcome of a vote they have been waiting on.
        sms: true,
        smsText: `Chuma: Your K${loan.principal} loan is approved and on its way to your wallet.`,
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

  if (approval.type === "member-removal" && approval.groupId) {
    const group = await Group.findById(approval.groupId);
    if (!group) return null;
    const member =
      group.members.id(approval.refId) ||
      group.members.find(
        (m) =>
          approval.targetUserId &&
          String(m.userId) === String(approval.targetUserId) &&
          m.status === "active"
      );
    if (!member || member.status !== "active") {
      await Approval.updateOne({ _id: approval._id }, { status: "executed" });
      approval.status = "executed";
      return { type: "member-removal-noop", reason: "member already left" };
    }

    // They hold an office now — proposed as an ordinary member, promoted while
    // the vote ran. An admin is never removed, so this stops here and the
    // approval stays runnable if the role is handed on later.
    if (ADMIN_ROLES.includes(member.role))
      return {
        type: "member-removal-blocked",
        reason: `${member.name} is now the group's ${member.role}. An admin cannot be removed. Hand the role to someone else first.`,
      };

    try {
      const result = await refundAndRemoveMember(group, member, {
        approvalId: approval._id,
      });
      // One-shot action: mark executed so a replay can never refund twice.
      await Approval.updateOne({ _id: approval._id }, { status: "executed" });
      approval.status = "executed";

      const chairId = group.governance?.chairpersonUserId;
      if (chairId) {
        await notify({
          userId: chairId,
          type: "governance",
          title: "Member removal approved",
          body: `${member.name} was removed from ${group.name}. K${result.refunded} refunded${result.appliedToLoan > 0 ? ` after K${result.appliedToLoan} cleared their loan` : ""}${result.pending ? ". The payout is on its way." : "."}`,
          groupId: group._id,
          groupName: group.name,
          // A member left and group money went with them. The chair answers
          // for both at the next meeting.
          sms: true,
          smsText: `Chuma: ${member.name} was removed from ${group.name}. K${result.refunded} was refunded to them.`,
        });
      }
      return { type: "member-removed", groupId: group._id, ...result };
    } catch (err) {
      if (err.status === 409) {
        // Wallet can't cover the refund yet. The approval stays "approved" so
        // admins can run it again once repayments land — nobody is removed and
        // no money moved.
        return { type: "member-removal-blocked", reason: err.message };
      }
      throw err;
    }
  }

  if (approval.type === "share-out" && approval.groupId) {
    const group = await Group.findById(approval.groupId);
    if (!group) return null;
    try {
      // The method the group voted for travels with the approval, so the run
      // pays the way the ballot said it would.
      const result = await distributeShareOut(group, {
        method: approval.payoutMethod,
      });
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
