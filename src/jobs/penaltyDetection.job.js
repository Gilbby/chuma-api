/**
 * Scheduled penalty-detection job.
 * Run daily (see cron schedule in src/server.js) or manually for testing:
 *   npm run cron:penalty
 *
 * Auto-detects two violation classes across all groups and issues penalties via
 * the shared issuePenalty() service:
 *   A) Late contributions — members who missed a closed cycle window.
 *   B) Late loan repayments — active loans past their nextDueDate.
 *
 * Idempotent by design: issuePenalty() dedupes on dueContext, so running this
 * daily never stacks duplicate penalties for the same missed cycle or the same
 * overdue due date.
 */
import { Group } from "../models/Group.js";
import { Loan } from "../models/Loan.js";
import { Transaction } from "../models/Transaction.js";
import { issuePenalty } from "../services/penalty.service.js";
import {
  computePenaltyAmount,
  findLateContributors,
  advanceContributionDate,
} from "../services/logic.service.js";

export async function runPenaltyDetection() {
  const now = new Date();
  let lateContributions = 0;
  let lateRepayments = 0;

  // ─── A) LATE CONTRIBUTIONS ─────────────────────────────────────────────────
  const groups = await Group.find({ status: "active" });
  for (const group of groups) {
    const c = group.constitution;
    if (!c?.penaltyRules?.lateContribution?.enabled) continue;
    if (!group.nextContributionDate) continue;

    const windowEnd = new Date(group.nextContributionDate);
    // Only act once the cycle window has closed.
    if (now < windowEnd) continue;
    // Skip if this cycle window was already reconciled.
    if (
      group.lastCycleReconciledAt &&
      new Date(group.lastCycleReconciledAt) >= windowEnd
    )
      continue;

    // Start of the not-yet-reconciled window: last reconcile point, else creation.
    const windowStart = new Date(group.lastCycleReconciledAt || group.createdAt);

    const txns = await Transaction.find({
      groupId: group._id,
      type: "contribution",
    }).lean();

    const lateIds = findLateContributors(group, txns, windowStart, windowEnd);
    for (const userId of lateIds) {
      const member = group.members.find(
        (m) => String(m.userId) === String(userId)
      );
      if (!member) continue;
      const amount = computePenaltyAmount(
        c.penaltyRules.lateContribution,
        group.contributionAmount,
        1
      );
      const p = await issuePenalty({
        group,
        member,
        violationType: "lateContribution",
        reason: "Late contribution",
        amount,
        dueContext: `cycle:${windowEnd.toISOString()}`,
      });
      if (p) lateContributions++;
    }

    // Advance exactly one window per run; groups multiple cycles behind get
    // caught up over subsequent daily runs.
    const nextContributionDate = advanceContributionDate(
      group.nextContributionDate,
      group.contributionFrequency
    );
    // Targeted $set of only the reconciliation-cursor fields. A full group.save()
    // here would persist every field at its read-time value, clobbering a
    // concurrent settlement's atomic $inc on walletBalance/totalSavings/etc.
    await Group.updateOne(
      { _id: group._id },
      { $set: { nextContributionDate, lastCycleReconciledAt: windowEnd } }
    );
  }

  // ─── B) LATE REPAYMENTS ────────────────────────────────────────────────────
  const activeLoans = await Loan.find({ status: "active" });
  for (const loan of activeLoans) {
    if (!loan.nextDueDate) continue;
    const dueDate = new Date(loan.nextDueDate);
    if (now <= dueDate) continue;

    const group = await Group.findById(loan.groupId);
    if (!group) continue;
    const c = group.constitution;
    if (!c?.penaltyRules?.lateRepayment?.enabled) continue;

    const member = group.members.find(
      (m) => String(m.userId) === String(loan.memberId)
    );
    if (!member) continue;

    const amount = computePenaltyAmount(
      c.penaltyRules.lateRepayment,
      loan.outstanding,
      1
    );
    const p = await issuePenalty({
      group,
      member,
      violationType: "lateRepayment",
      reason: "Late loan repayment",
      amount,
      dueContext: `loan:${loan._id}:${dueDate.toISOString()}`,
    });
    if (p) lateRepayments++;

    // Mark the loan visibly overdue; the repay handler accepts "overdue" loans.
    // Guarded targeted $set: flip status only while still "active", so a
    // concurrent repayment settlement that completed the loan isn't reverted,
    // and its atomic $inc on outstanding/installmentsPaid isn't clobbered by a
    // full loan.save() of read-time values.
    await Loan.updateOne(
      { _id: loan._id, status: "active" },
      { $set: { status: "overdue" } }
    );
  }

  console.log(
    `[penaltyDetection] Issued ${lateContributions} late-contribution and ${lateRepayments} late-repayment penalty(ies).`
  );
  return { lateContributions, lateRepayments };
}

// Standalone run for manual testing: `node src/jobs/penaltyDetection.job.js`
// pathToFileURL handles Windows drive letters and spaces in the path, which a
// naive `file://${process.argv[1]}` comparison gets wrong.
const { pathToFileURL } = await import("url");
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await import("dotenv/config");
  const { connectDB } = await import("../config/db.js");
  const mongoose = (await import("mongoose")).default;

  connectDB()
    .then(() => runPenaltyDetection())
    .then(() => mongoose.disconnect())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
