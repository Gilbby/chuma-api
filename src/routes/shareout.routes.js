import express from "express";
import { Group } from "../models/Group.js";
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
import {
  distributeShareOut,
  getPenaltyIncome,
} from "../services/shareout.service.js";

const router = express.Router();

/**
 * One share-out transaction as a payout row: what the member was owed, what
 * they are actually handed, and who we are waiting on for it.
 */
function toPayoutRow(t) {
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
    // Manual payouts stamp meta.confirmedBy* (manualPayout.service); the
    // cash* names belong to money coming IN. Read both, or a payout the
    // treasurer confirmed shows up with nobody's name against it.
    confirmedByName: t.meta?.confirmedByName || t.meta?.cashConfirmedByName || null,
    confirmedAt: t.meta?.confirmedAt || t.meta?.cashConfirmedAt || null,
    receiptId: t.receiptId,
    date: t.createdAt,
  };
}

function totalsFor(payouts) {
  return {
    count: payouts.length,
    paid: payouts.filter((p) => p.status === "completed").length,
    pending: payouts.filter((p) => p.status === "pending").length,
    failed: payouts.filter((p) => p.status === "failed").length,
    outstanding: payouts
      .filter((p) => p.status === "pending")
      .reduce((sum, p) => sum + p.amount, 0),
  };
}

/**
 * A run is over only when EVERY member's payout has settled. A failed payout
 * keeps the run open on purpose — somebody still has to deal with it, and a
 * distribution that quietly closed over a member who never got paid is the one
 * outcome this whole screen exists to prevent.
 */
const isRunClosed = (payouts) =>
  payouts.length > 0 && payouts.every((p) => p.status === "completed");

/**
 * How a run paid, read off the transactions rather than the approval: the
 * approval records an intention, the transactions record what actually
 * happened once the hold had its say.
 */
const methodOf = (payouts) =>
  payouts.some((p) => p.viaMobileMoney) ? "mobile-money" : "manual";

/** When the last member was settled. Falls back to the last row written. */
const settledAtOf = (payouts) =>
  payouts
    .map((p) => p.confirmedAt)
    .filter(Boolean)
    .sort((a, b) => new Date(b) - new Date(a))[0] ||
  payouts[payouts.length - 1]?.date ||
  null;

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
 * The distribution the group is CURRENTLY paying out, member by member: who has
 * been paid, who is still owed, and who is waiting on a provider.
 *
 * Only a run still in flight is returned. The moment the last member is
 * settled the distribution is finished business — it stops being the thing the
 * share-out screen is about and becomes a record, served by /history, so the
 * screen is clear for the next cycle instead of permanently showing a
 * "2 of 2 paid" the group has already been through. `lastCompleted` is the
 * receipt of that: enough to say a share-out happened and point at the report,
 * and not enough to be mistaken for a live one.
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
    const clear = {
      shareOutId: null,
      payouts: [],
      totals: null,
      method: null,
      lastCompleted: null,
      mobileMoneyHold,
    };

    if (!latest) return res.json(clear);

    const rows = await Transaction.find({
      groupId: req.group._id,
      type: "share-out",
      "meta.shareOutId": latest.meta.shareOutId,
    })
      .sort({ createdAt: 1 })
      .lean();

    const payouts = rows.map(toPayoutRow);

    // Done and dusted. Hand back the clear screen plus a one-line receipt, so
    // the group can see that a share-out happened and go and read it, without
    // the finished distribution sitting where the next one belongs.
    if (isRunClosed(payouts))
      return res.json({
        ...clear,
        lastCompleted: {
          shareOutId: String(latest.meta.shareOutId),
          completedAt: settledAtOf(payouts),
          memberCount: payouts.length,
          totalPaid: payouts.reduce((sum, p) => sum + p.amount, 0),
          method: methodOf(payouts),
        },
      });

    res.json({
      shareOutId: String(latest.meta.shareOutId),
      payouts,
      totals: totalsFor(payouts),
      method: methodOf(payouts),
      lastCompleted: null,
      mobileMoneyHold,
    });
  })
);

/**
 * GET /api/shareout/:groupId/history  (auth, member)  ?limit=12
 * Every distribution this group has run, newest first, each with its full
 * member-by-member detail.
 *
 * This is where a finished share-out goes to live. The share-out screen only
 * ever shows the run in progress, so without somewhere permanent to read it,
 * closing a cycle would erase the record of what it paid — and "what did we
 * each get last year" is a question a savings group asks constantly.
 *
 * Every member sees the whole thing, for the same reason they see a live run:
 * the ledger is the group's, not the treasurer's.
 */
router.get(
  "/:groupId/history",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 50);

    // Group in the database and take only the newest runs, so a group with ten
    // years of cycles still reads ten rows rather than every payout it ever made.
    const runIds = await Transaction.aggregate([
      {
        $match: {
          groupId: req.group._id,
          type: "share-out",
          "meta.shareOutId": { $exists: true },
        },
      },
      { $group: { _id: "$meta.shareOutId", startedAt: { $min: "$createdAt" } } },
      { $sort: { startedAt: -1 } },
      { $limit: limit },
    ]);
    if (!runIds.length) return res.json({ runs: [] });

    const rows = await Transaction.find({
      groupId: req.group._id,
      type: "share-out",
      "meta.shareOutId": { $in: runIds.map((r) => r._id) },
    })
      .sort({ createdAt: 1 })
      .lean();

    const byRun = new Map(runIds.map((r) => [String(r._id), []]));
    for (const t of rows) byRun.get(String(t.meta.shareOutId))?.push(toPayoutRow(t));

    const runs = runIds.map((r) => {
      const payouts = byRun.get(String(r._id)) ?? [];
      const closed = isRunClosed(payouts);
      return {
        shareOutId: String(r._id),
        startedAt: r.startedAt,
        // Null while a run is still being paid — the one on the share-out
        // screen appears here too, marked open, rather than going missing.
        completedAt: closed ? settledAtOf(payouts) : null,
        closed,
        method: methodOf(payouts),
        memberCount: payouts.length,
        totalOwed: payouts.reduce((sum, p) => sum + p.owed, 0),
        totalPaid: payouts
          .filter((p) => p.status === "completed")
          .reduce((sum, p) => sum + p.amount, 0),
        totalAppliedToLoans: payouts.reduce((sum, p) => sum + p.appliedToLoan, 0),
        totals: totalsFor(payouts),
        payouts,
      };
    });

    res.json({ runs });
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

    // An empty pot has nothing to hand out. This matters most right after a
    // share-out closes: every member's savings are zero, so a second proposal
    // computes every share to zero, writes no payout at all, and spends a
    // unanimous admin vote on nothing while looking like it worked.
    const pot = group.members
      .filter((m) => m.status === "active")
      .reduce((sum, m) => sum + (m.savings || 0), 0);
    if (pot <= 0)
      return res.status(400).json({
        error:
          "There is nothing to share out yet. Members need to contribute to this cycle first.",
      });

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
