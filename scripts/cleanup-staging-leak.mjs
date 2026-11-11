/**
 * One-off clean-up after the staging API wrote to the PRODUCTION database
 * (connectDB forced dbName "chuma"; fixed in e907fca). Exposure window:
 * 2026-11-07 16:52 UTC -> 2026-11-08 08:56 UTC. See the audit in
 * chuma/STAGING_DB_AUDIT_HANDOFF.md.
 *
 *   node scripts/cleanup-staging-leak.mjs           # dry run - prints what would change
 *   node scripts/cleanup-staging-leak.mjs --apply   # writes it
 *
 * The production URI must be passed explicitly as CLEANUP_MONGODB_URI (never
 * read from .env, which points at a local DB). The script prints the host and
 * database it connected to before doing anything.
 *
 * What it undoes - only things production's own code (billing off, group fees
 * off) never writes:
 *   1. user.plan            - a sandbox test subscription synced from RevenueCat
 *   2. group.billing        - stamped by billing.service recomputeCoverage
 *      group.lastFeeReminderSentAt
 *      group.feePaidThrough - removed only where staging stamped it (it equals
 *                             billing.legacyFreeUntil, or the group was made in
 *                             the window). Production creates groups without it.
 *   3. closes groups CREATED inside the window (test groups made through
 *      staging), only if they have at most one active member.
 *
 * Uses the raw collections (not the Mongoose models) so paths the main-branch
 * schema doesn't know about, like "billing", can still be $unset.
 * Phone numbers are printed masked to their last 3 digits.
 */
import mongoose from "mongoose";

const WINDOW_START = new Date("2026-11-07T16:52:00Z");
const WINDOW_END = new Date("2026-11-08T08:56:00Z");
const apply = process.argv.includes("--apply");

const uri = process.env.CLEANUP_MONGODB_URI;
if (!uri) {
  console.error(
    "Set CLEANUP_MONGODB_URI to the production connection string first (copy it from Render).\n" +
      "It is deliberately not read from .env."
  );
  process.exit(1);
}

const mask = (p) => (p ? `…${String(p).replace(/\D/g, "").slice(-3)}` : "-");
const iso = (d) => (d ? new Date(d).toISOString() : "-");
const sameTime = (a, b) => a && b && new Date(a).getTime() === new Date(b).getTime();

await mongoose.connect(uri);
const db = mongoose.connection.db;
const host = mongoose.connection.host;
console.log(`Connected: host=${host} db=${db.databaseName}  mode=${apply ? "APPLY" : "dry run"}`);
console.log(`Window: ${iso(WINDOW_START)} -> ${iso(WINDOW_END)}\n`);

const users = db.collection("users");
const groups = db.collection("groups");

// ── 1. users with a plan ─────────────────────────────────────────────────────
const planUsers = await users
  .find({ plan: { $exists: true } }, { projection: { phone: 1, plan: 1, createdAt: 1 } })
  .toArray();
console.log(`1) Users with a plan field: ${planUsers.length}`);
for (const u of planUsers) {
  console.log(
    `   ${u._id} ${mask(u.phone)}  limit=${u.plan?.groupLimit ?? "-"} base=${u.plan?.basePlanId ?? "-"} ` +
      `expires=${iso(u.plan?.expiresAt)} willRenew=${u.plan?.willRenew ?? "-"}  -> unset plan`
  );
}

// ── 2. groups with billing fields ────────────────────────────────────────────
const billed = await groups
  .find(
    {
      $or: [
        { billing: { $exists: true } },
        { lastFeeReminderSentAt: { $exists: true } },
      ],
    },
    {
      projection: {
        name: 1, status: 1, createdAt: 1, feePaidThrough: 1, lastFeeReminderSentAt: 1,
        billing: 1, "governance.chairpersonUserId": 1, members: 1,
      },
    }
  )
  .toArray();

const inWindow = (g) => g.createdAt && g.createdAt >= WINDOW_START && g.createdAt <= WINDOW_END;
const plan2 = billed.map((g) => {
  const unset = { billing: "" };
  if (g.lastFeeReminderSentAt) unset.lastFeeReminderSentAt = "";
  const stampedPaidThrough =
    g.feePaidThrough && (sameTime(g.feePaidThrough, g.billing?.legacyFreeUntil) || inWindow(g));
  if (stampedPaidThrough) unset.feePaidThrough = "";
  return { g, unset, keptPaidThrough: g.feePaidThrough && !stampedPaidThrough };
});

console.log(`\n2) Groups with billing fields: ${billed.length}`);
for (const { g, unset, keptPaidThrough } of plan2) {
  console.log(
    `   ${g._id} "${g.name}" [${g.status}] created=${iso(g.createdAt)}${inWindow(g) ? " (in window)" : ""}\n` +
      `      billing=${JSON.stringify(g.billing ?? null)} feePaidThrough=${iso(g.feePaidThrough)} ` +
      `lastFeeReminderSentAt=${iso(g.lastFeeReminderSentAt)}\n` +
      `      -> unset ${Object.keys(unset).join(", ")}` +
      (keptPaidThrough ? `  (KEEPING feePaidThrough - not stamped by staging)` : "")
  );
}

// ── 3. test groups created in the window ─────────────────────────────────────
const created = await groups
  .find(
    { createdAt: { $gte: WINDOW_START, $lte: WINDOW_END } },
    { projection: { name: 1, status: 1, createdAt: 1, members: 1, "governance.chairpersonUserId": 1 } }
  )
  .toArray();
const activeMembers = (g) => (g.members || []).filter((m) => m.status === "active");
const toClose = created.filter((g) => g.status !== "closed" && activeMembers(g).length <= 1);
const skipped = created.filter((g) => g.status !== "closed" && activeMembers(g).length > 1);

console.log(`\n3) Groups created in the window: ${created.length}`);
for (const g of created) {
  const act = activeMembers(g);
  const verdict =
    g.status === "closed" ? "already closed" : act.length <= 1 ? "-> close" : "SKIP (more than one active member)";
  console.log(
    `   ${g._id} "${g.name}" [${g.status}] created=${iso(g.createdAt)} active members=${act.length} ` +
      `(${act.map((m) => mask(m.phone)).join(", ") || "-"})  ${verdict}`
  );
}

console.log(
  `\nSummary: unset plan on ${planUsers.length} user(s); clear billing on ${plan2.length} group(s); ` +
    `close ${toClose.length} group(s)${skipped.length ? `; ${skipped.length} skipped` : ""}.`
);

if (!apply) {
  console.log("Dry run - nothing written. Re-run with --apply to write.");
  await mongoose.disconnect();
  process.exit(0);
}

// ── apply ────────────────────────────────────────────────────────────────────
let n = 0;
for (const u of planUsers) {
  const r = await users.updateOne({ _id: u._id }, { $unset: { plan: "" } });
  n += r.modifiedCount;
}
console.log(`Users updated: ${n}`);

n = 0;
for (const { g, unset } of plan2) {
  const r = await groups.updateOne({ _id: g._id }, { $unset: unset });
  n += r.modifiedCount;
}
console.log(`Groups cleared: ${n}`);

n = 0;
for (const g of toClose) {
  const r = await groups.updateOne(
    { _id: g._id, status: g.status }, // only if nobody changed it since the read
    { $set: { status: "closed", updatedAt: new Date() } }
  );
  n += r.modifiedCount;
}
console.log(`Groups closed: ${n}`);

await mongoose.disconnect();
console.log("Done.");
