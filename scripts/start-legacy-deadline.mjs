/**
 * Start the free window for groups that existed before Play billing launched.
 *
 *   npm run billing:legacy-deadline            # dry run - shows what would change
 *   npm run billing:legacy-deadline -- --apply # writes it
 *
 * Every non-closed group without one gets billing.legacyFreeUntil = now +
 * BILLING_LEGACY_GRACE_DAYS (default 30) and its covered-until date
 * (feePaidThrough) pushed out to at least that. Each founder's coverage is then
 * recomputed, so a founder who already bought a plan has it applied too.
 *
 * Run it ONCE, right when PLAY_BILLING_ENABLED is switched on in production.
 * Re-running is safe: groups that already have a window are left alone.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import { Group } from "../src/models/Group.js";
import config from "../src/config/index.js";
import { recomputeCoverage } from "../src/services/billing.service.js";

const apply = process.argv.includes("--apply");
const days = config.billing.legacyGraceDays;

if (!config.billing.playBillingEnabled) {
  console.error(
    "PLAY_BILLING_ENABLED is off. Turn it on first - otherwise the deadline is stamped but never enforced."
  );
  process.exit(1);
}

await connectDB();

const now = new Date();
const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
const groups = await Group.find({
  status: { $ne: "closed" },
  "billing.legacyFreeUntil": { $exists: false },
})
  .select("name status feePaidThrough governance.chairpersonUserId")
  .lean();

console.log(
  `${groups.length} group(s) get a free window until ${until.toISOString()} (${days} days).`
);
const orphans = groups.filter((g) => !g.governance?.chairpersonUserId);
if (orphans.length)
  console.warn(
    `  ${orphans.length} have no founder on record (account deleted) - nobody can buy a plan for them, so they will lock after the window:`,
    orphans.map((g) => g.name).join(", ")
  );

if (!apply) {
  console.log("Dry run. Re-run with --apply to write.");
  await mongoose.disconnect();
  process.exit(0);
}

for (const g of groups) {
  const paidThrough =
    g.feePaidThrough && new Date(g.feePaidThrough) > until ? g.feePaidThrough : until;
  await Group.updateOne(
    { _id: g._id },
    {
      $set: {
        "billing.legacyFreeUntil": until,
        feePaidThrough: paidThrough,
        monthlyFee: config.rules.groupMonthlyFee,
        // A legacy group that was stuck waiting on the old pawaPay fee starts
        // now - it gets the same free window as everyone else.
        ...(g.status === "pending-payment" ? { status: "active" } : {}),
      },
    }
  );
}

const founders = [
  ...new Set(
    groups.map((g) => g.governance?.chairpersonUserId).filter(Boolean).map(String)
  ),
];
for (const id of founders) await recomputeCoverage(id);

console.log(`Done: ${groups.length} group(s) stamped, ${founders.length} founder(s) recomputed.`);
await mongoose.disconnect();
