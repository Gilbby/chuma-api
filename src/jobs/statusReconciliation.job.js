/**
 * PawaPay status-reconciliation job.
 * Run every 5 minutes (see cron schedule in src/server.js) or manually:
 *   npm run cron:reconcile
 *
 * Safety net for transactions whose PawaPay callback never arrived (common in
 * the sandbox): polls GET /deposits/:id or /payouts/:id for the true final
 * status and applies the SAME atomic pending→final transition the webhook
 * does (see applyFinalStatus in src/routes/webhook.routes.js), so a late
 * callback and this cron can never double-apply.
 *
 * Idempotent by design: only FINAL statuses (COMPLETED/FAILED) act, the
 * update is guarded on status:"pending", and anything not yet final is left
 * untouched to be retried next run.
 */
import { Transaction } from "../models/Transaction.js";
import {
  checkDepositStatus,
  checkPayoutStatus,
} from "../services/pawapay.service.js";
import {
  settleCompletedTransaction,
  handleFailedTransaction,
} from "../services/settlement.service.js";

// Grace window: don't poll transactions initiated moments ago — their
// callback may legitimately still be in flight.
const RECONCILE_MIN_AGE_MS = 2 * 60 * 1000;
// Stop polling transactions this old: PawaPay finalises within minutes, so a
// week-old pending transaction is stuck data, not an in-flight payment.
// Without a ceiling every stuck transaction is polled every 5 minutes forever
// — unbounded PawaPay API traffic that only ever grows.
const RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Cap PawaPay status polls per run so a backlog can't blow past the 5-minute
// cron interval; the remainder is picked up on subsequent runs.
const RECONCILE_BATCH_LIMIT = 100;

const FINAL_STATUSES = ["COMPLETED", "FAILED"];

// node-cron fires on schedule even if the previous run is still going; a slow
// PawaPay would stack overlapping sweeps polling the same transactions.
let sweepInProgress = false;

export async function runStatusReconciliation() {
  if (sweepInProgress) {
    console.warn("[statusReconciliation] previous sweep still running — skipped");
    return null;
  }
  sweepInProgress = true;
  try {
    return await sweep();
  } finally {
    sweepInProgress = false;
  }
}

async function sweep() {
  const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MS);
  const maxAgeCutoff = new Date(Date.now() - RECONCILE_MAX_AGE_MS);
  const pawapayLinked = [
    { "pawapay.depositId": { $exists: true, $ne: null } },
    { "pawapay.payoutId": { $exists: true, $ne: null } },
  ];

  const candidates = await Transaction.find({
    status: "pending",
    createdAt: { $lte: cutoff, $gte: maxAgeCutoff },
    $or: pawapayLinked,
  })
    .sort({ createdAt: 1 }) // oldest first — closest to timing out of the window
    .limit(RECONCILE_BATCH_LIMIT);

  // Aged out of the polling window: surface loudly for manual review — these
  // need a human (check the PawaPay dashboard / resend-callback), not a poll.
  const expired = await Transaction.countDocuments({
    status: "pending",
    createdAt: { $lt: maxAgeCutoff },
    $or: pawapayLinked,
  });
  if (expired > 0) {
    console.error(
      `[statusReconciliation] ${expired} pending transaction(s) older than 7 days — no longer polled, review manually`
    );
  }

  const counts = {
    reconciledCompleted: 0,
    reconciledFailed: 0,
    stillPending: 0,
    noOp: 0,
  };

  for (const txn of candidates) {
    const result = txn.pawapay?.depositId
      ? await checkDepositStatus(txn.pawapay.depositId)
      : await checkPayoutStatus(txn.pawapay.payoutId);

    const status = result?.status;
    if (!FINAL_STATUSES.includes(status)) {
      // ACCEPTED / SUBMITTED / PENDING / UNKNOWN — retry next run.
      counts.stillPending++;
      continue;
    }

    // Same atomic guard as the webhook: only a still-pending transaction can
    // transition, so a callback landing mid-run makes this a harmless no-op.
    const updated = await Transaction.findOneAndUpdate(
      { _id: txn._id, status: "pending" },
      {
        status: status === "COMPLETED" ? "completed" : "failed",
        "pawapay.status": status,
        ...(status === "FAILED" && result.failureReason
          ? { "pawapay.failureReason": JSON.stringify(result.failureReason) }
          : {}),
      },
      { new: true }
    );

    if (!updated) {
      counts.noOp++;
      continue;
    }

    // We won the pending→final flip: apply settlement effects exactly once,
    // same as the webhook path. Log loudly on error; don't abort the sweep.
    try {
      if (status === "COMPLETED") await settleCompletedTransaction(updated);
      else await handleFailedTransaction(updated);
    } catch (err) {
      console.error(
        `[SETTLEMENT] FAILED to apply effects for txn ${updated._id} (${updated.type}, ${status}):`,
        err
      );
    }

    if (status === "COMPLETED") {
      counts.reconciledCompleted++;
    } else {
      counts.reconciledFailed++;
    }
  }

  console.log(
    `[statusReconciliation] completed=${counts.reconciledCompleted} failed=${counts.reconciledFailed} still-pending=${counts.stillPending} no-op=${counts.noOp} (of ${candidates.length} candidate(s))`
  );
  return counts;
}

// Standalone run for manual testing: `node src/jobs/statusReconciliation.job.js`
// pathToFileURL handles Windows drive letters and spaces in the path, which a
// naive `file://${process.argv[1]}` comparison gets wrong.
const { pathToFileURL } = await import("url");
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await import("dotenv/config");
  const { connectDB } = await import("../config/db.js");
  const mongoose = (await import("mongoose")).default;

  connectDB()
    .then(() => runStatusReconciliation())
    .then(() => mongoose.disconnect())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
