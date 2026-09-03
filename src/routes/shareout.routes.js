import express from "express";
import { Group } from "../models/Group.js";
import { Penalty } from "../models/Penalty.js";
import { Approval } from "../models/Approval.js";
import { notifyAll } from "../services/notify.service.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import {
  requireGroupMember,
  requireGroupAdmin,
  ADMIN_ROLES,
} from "../middleware/groupAuth.js";
import {
  computeShareOut,
  estimateGroupProfit,
  computeLoanNetting,
  getRequiredApprovals,
} from "../services/logic.service.js";
import { Loan } from "../models/Loan.js";
import { Transaction } from "../models/Transaction.js";
import { awaitsConfirmation } from "../services/manualPayout.service.js";
import { isMobileMoneyOnHold } from "../utils/paymentHold.js";
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

    // Net any still-open loans against each borrower's share so the preview
    // shows what members will actually receive in cash.
    const openLoans = await Loan.find({
      groupId: group._id,
      status: { $in: ["active", "overdue"] },
    }).select("memberId outstanding");
    const netted = computeLoanNetting(result.members, openLoans);

    res.json({
      groupId: group._id,
      groupName: group.name,
      shareOutDate: group.shareOutDate,
      penaltyIncome,
      ...result,
      members: netted.members,
      totalNetCash: netted.totalNetCash,
    });
  })
);

/**
 * GET /api/shareout/:groupId/payouts  (auth, member)
 * The state of the group's most recent distribution, member by member: who has
 * been paid, who is still owed, and who is waiting on a provider.
 *
 * Every member sees this, not just admins. A share-out where only the treasurer
 * can see who has been paid is the exact ledger a VSLA meets in person to
 * avoid — and a member who has NOT been handed their money needs a row to point
 * at that says so.
 *
 * Also reports whether the mobile money hold is on, which is what decides
 * whether the next proposal gets to choose a method at all.
 */
router.get(
  "/:groupId/payouts",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    // The latest run, found through its own transactions: one distribution
    // stamps every transaction it writes with the same meta.shareOutId.
    const latest = await Transaction.findOne({
      groupId: req.group._id,
      type: "share-out",
      "meta.shareOutId": { $exists: true },
    })
      .sort({ createdAt: -1 })
      .lean();

    const mobileMoneyHold = isMobileMoneyOnHold();

    if (!latest)
      return res.json({
        shareOutId: null,
        payouts: [],
        totals: null,
        method: null,
        mobileMoneyHold,
      });

    const rows = await Transaction.find({
      groupId: req.group._id,
      type: "share-out",
      "meta.shareOutId": latest.meta.shareOutId,
    })
      .sort({ createdAt: 1 })
      .lean();

    const payouts = rows.map((t) => {
      const owed = Math.abs(t.amount);
      const handed = t.depositAmount ?? owed;
      return {
        transactionId: String(t._id),
        memberId: t.memberId ? String(t.memberId) : null,
        memberName: t.memberName,
        owed,
        amount: handed, // what they actually get, after their own loan is netted
        appliedToLoan: Math.max(0, owed - handed),
        status: t.status,
        paymentMethod: t.paymentMethod || null,
        // Waiting on a person to pay and say so, vs waiting on pawaPay. That
        // difference is the point of this screen: only the first has a button.
        awaitsConfirmation: awaitsConfirmation(t),
        viaMobileMoney: !!t.pawapay?.transfers?.length,
        confirmedByName: t.meta?.cashConfirmedByName || null,
        confirmedAt: t.meta?.cashConfirmedAt || null,
        receiptId: t.receiptId,
        date: t.createdAt,
      };
    });

    const totals = {
      count: payouts.length,
      paid: payouts.filter((p) => p.status === "completed").length,
      pending: payouts.filter((p) => p.status === "pending").length,
      failed: payouts.filter((p) => p.status === "failed").length,
      outstanding: payouts
        .filter((p) => p.status === "pending")
        .reduce((sum, p) => sum + p.amount, 0),
    };

    res.json({
      shareOutId: String(latest.meta.shareOutId),
      payouts,
      totals,
      // How THIS run paid, read off the transactions rather than the approval:
      // the approval records an intention, the transactions record what
      // actually happened when the hold had its say.
      method: payouts.some((p) => p.viaMobileMoney) ? "mobile-money" : "manual",
      mobileMoneyHold,
    });
  })
);

/**
 * POST /api/shareout/:groupId/propose  (auth, CHAIRPERSON only)
 * Body: { method?: "manual" | "mobile-money" }
 * Creates a pending share-out Approval routed to the other admins instead of
 * paying out immediately. Only one pending share-out per group at a time.
 *
 * The chairperson alone initiates. Ending a cycle is the single largest thing a
 * group does — it empties the pool and closes everyone's savings — so it starts
 * with the person the group elected to hold that decision, not with whoever
 * happens to open the screen. The treasurer and secretary then approve it, and
 * approval must be UNANIMOUS across the group's active admins: there is no
 * majority worth having when the whole pot is being handed out.
 *
 * The method is chosen here and fixed for the whole run, because it decides
 * what the admins are actually voting for: a MANUAL run commits the group to
 * paying every member themselves — notes, the treasurer's own mobile money, a
 * bank transfer — and confirming each one, while a mobile money run is one vote
 * and then pawaPay does the rest. It goes in the description so nobody approves
 * a fortnight of paying people by hand without meaning to.
 *
 * While the mobile money hold is on there is no choice to make — pawaPay
 * disbursement cannot pay anyone — so a request for it is corrected to manual
 * rather than refused. The group still gets its share-out.
 */
router.post(
  "/:groupId/propose",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const group = req.group;
    if (req.member.role !== "Chairperson")
      return res
        .status(403)
        .json({ error: "Only the chairperson can start a share-out" });

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

    // Unanimous, and counted over ACTIVE admins only: an invited treasurer who
    // has not accepted yet cannot vote, so counting them would set a bar the
    // group can never reach. A group whose only admin is the chairperson needs
    // one approval — their own — which their initiating vote supplies.
    const activeAdmins = group.members.filter(
      (m) => m.status === "active" && ADMIN_ROLES.includes(m.role)
    );
    const required = getRequiredApprovals("all", activeAdmins.length);

    const held = isMobileMoneyOnHold();
    const asked = req.body?.method;
    if (asked && !["manual", "mobile-money"].includes(asked))
      return res
        .status(400)
        .json({ error: "Method must be manual or mobile-money" });
    // Manual is the default as well as the fallback: it is the one method that
    // works whatever pawaPay is doing.
    const payoutMethod = held || asked !== "mobile-money" ? "manual" : "mobile-money";
    const methodLine =
      payoutMethod === "manual"
        ? "The group pays each member directly and confirms each one in the app."
        : "Paid to members' mobile money wallets automatically once approved.";

    const approval = await Approval.create({
      groupId: group._id,
      groupName: group.name,
      type: "share-out",
      title: `Share-out distribution — ${group.name}`,
      description: `Approve end-of-cycle distribution of K${result.totalToDistribute} to members. ${methodLine}`,
      amount: result.totalToDistribute,
      requestedById: req.userId,
      requestedBy: req.user.name,
      requiredApprovals: required,
      payoutMethod,
    });

    // Everyone whose approval is still needed — not the chairperson, who is
    // the one asking and whose vote is cast by the same tap.
    const toAsk = activeAdmins.filter(
      (m) => String(m.userId) !== String(req.userId)
    );
    await notifyAll(
      toAsk.map((a) => a.userId),
      {
        type: "governance",
        title: "Share-out approval needed",
        body: `${req.user.name} proposed a share-out of K${result.totalToDistribute} in ${group.name}, paid ${payoutMethod === "manual" ? "directly by the group" : "by mobile money"}.`,
        groupId: group._id,
        groupName: group.name,
        // End of cycle. Every member's payout waits on this vote.
        sms: true,
        smsText: `Chuma: ${req.user.name} proposed a K${result.totalToDistribute} share-out in ${group.name}. Your approval is needed. Vote in the app.`,
      }
    );

    res.status(201).json({
      approval,
      // Say so when the request was overridden, rather than letting the screen
      // show a mobile money run that is quietly going to be cash.
      method: payoutMethod,
      mobileMoneyHold: held,
    });
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
  // Deliberately no requireKyc: verification is asked for exactly once, at
  // group creation, of the founder who becomes Chairperson. A Treasurer or
  // Secretary is invited into their role and never verifies, so gating this
  // would lock them out of a share-out they are entitled to run.
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

    try {
      const { payouts, summary } = await distributeShareOut(req.group, {
        method: approval.payoutMethod,
      });
      res.json({ message: "Share-out distributed", payouts, summary });
    } catch (err) {
      if (err.status === 409) {
        // The wallet guard throws before ANY payout is sent, so the approval
        // can safely be released back to "approved" for a later attempt.
        await Approval.updateOne(
          { _id: approval._id },
          { status: "approved" }
        );
        return res.status(409).json({ error: err.message });
      }
      throw err;
    }
  })
);

export default router;
