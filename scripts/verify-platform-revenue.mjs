// Verification for the platform-fee booking added to the contribution
// settlement branch. Proves that when a contribution settles the service:
//   (a) credits the pool by EXACTLY the base (K100), never the grossed-up
//       deposit (K109) and never base+fee (K102),
//   (b) keeps the K2 platform fee OUT of the pool — it lands in PlatformRevenue,
//       a side record that changes no group/wallet/savings figure, and
//   (c) books that fee EXACTLY ONCE — a replayed callback reaching the
//       settlement body again must not double-book, thanks to the unique+sparse
//       transactionId index plus the 11000 swallow.
// Runs directly against the service (no HTTP); cleans up everything.
//
// Usage: npm run verify:platform-revenue
import "dotenv/config";
import dns from "dns";
// The local router's DNS intermittently SERVFAILs TXT/SRV lookups; bypass it.
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.promises.setServers(["8.8.8.8", "1.1.1.1"]);
import mongoose from "mongoose";

let connected = false;
for (let i = 1; i <= 5 && !connected; i++) {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
    connected = true;
  } catch (e) {
    console.log(`mongo connect attempt ${i} failed: ${e.message} — retrying in 10s`);
    await new Promise((r) => setTimeout(r, 10000));
  }
}
if (!connected) {
  console.error("Could not reach Atlas — network problem. Re-run later.");
  process.exit(2);
}
const { settleCompletedTransaction } = await import("../src/services/settlement.service.js");
const { PlatformRevenue } = await import("../src/models/PlatformRevenue.js");
// Ensure the unique+sparse transactionId index is actually built before we
// test exactly-once — otherwise the second booking would silently succeed.
await PlatformRevenue.init();
const db = mongoose.connection.db;
const oid = () => new mongoose.Types.ObjectId();

const results = [];
const check = (name, cond, detail = "") => {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` — ${detail}`}`);
};

const groupId = oid();
const memberId = oid();
const txnId = oid();
const now = new Date();

await db.collection("groups").insertOne({
  _id: groupId, name: "PLATFORM REVENUE VERIFY (synthetic)", groupType: "savings-group",
  totalSavings: 0, walletBalance: 0, loanCirculation: 0, cycleProgress: 0,
  members: [{ userId: memberId, name: "Revenue member", role: "Member", status: "active", savings: 0, contributions: 0 }],
  status: "active", createdAt: now, updatedAt: now,
});
// Persist a real contribution transaction, exactly as the route writes it:
// amount = -100 (base, stored negative = money out), depositAmount = 109
// (grossed-up, must NOT be pooled), platformFee = 2 (the K2).
await db.collection("transactions").insertOne({
  _id: txnId, type: "contribution", status: "completed",
  amount: -100, depositAmount: 109, platformFee: 2,
  memberId, groupId, groupName: "PLATFORM REVENUE VERIFY (synthetic)",
  contributionType: "cycle", paymentMethod: "MTN MoMo",
  createdAt: now, updatedAt: now,
});
console.log(`Seeded synthetic group ${groupId} and contribution ${txnId}`);

try {
  // Load the persisted doc back and settle it — same object the callback path
  // would hand to the service.
  const txn = await db.collection("transactions").findOne({ _id: txnId });

  // ── 1. FIRST settle: pool credited by EXACTLY base (K100) ──
  await settleCompletedTransaction(txn);
  let g = await db.collection("groups").findOne({ _id: groupId });
  let member = g.members.find((m) => String(m.userId) === String(memberId));
  check("pool credited by exactly BASE (savings=100, not 109/102)",
    member.savings === 100, `savings=${member.savings}`);
  check("totalSavings=100 — K2 did NOT leak into the pool",
    g.totalSavings === 100, `totalSavings=${g.totalSavings}`);
  check("walletBalance=100 — grossed-up 109 not pooled",
    g.walletBalance === 100, `walletBalance=${g.walletBalance}`);
  check("member.contributions incremented to 1",
    member.contributions === 1, `contributions=${member.contributions}`);

  // ── 2. PlatformRevenue side record: exactly one, K2, source contribution ──
  let revDocs = await db.collection("platformrevenues").find({ transactionId: txnId }).toArray();
  check("exactly ONE PlatformRevenue doc booked for this txn",
    revDocs.length === 1, `count=${revDocs.length}`);
  check("PlatformRevenue amount=2, source=contribution",
    revDocs.length === 1 && revDocs[0].amount === 2 && revDocs[0].source === "contribution",
    `doc=${JSON.stringify(revDocs[0])}`);
  check("group figures unchanged by the side record (still 100/100)",
    g.totalSavings === 100 && g.walletBalance === 100,
    `totalSavings=${g.totalSavings} wallet=${g.walletBalance}`);

  // ── 3. SECOND settle of the SAME txn (replayed callback reaching the body) ──
  // We assert ONLY the booking's idempotency: the unique+sparse index + the
  // 11000 swallow must keep PlatformRevenue at exactly one doc. The pool $inc
  // DOES double-apply on a direct second call — that is EXPECTED here and is
  // prevented in production upstream by the atomic pending→final guard, NOT by
  // this branch. So we deliberately do not assert the pool stays unchanged.
  await settleCompletedTransaction(txn);
  revDocs = await db.collection("platformrevenues").find({ transactionId: txnId }).toArray();
  check("second settle does NOT double-book platform revenue (still exactly 1)",
    revDocs.length === 1, `count=${revDocs.length}`);
} finally {
  await db.collection("groups").deleteOne({ _id: groupId });
  await db.collection("transactions").deleteOne({ _id: txnId });
  await db.collection("platformrevenues").deleteMany({ transactionId: txnId });
  console.log("Cleanup done — synthetic platform-revenue documents removed.");
  await mongoose.disconnect();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\nFAIL (${results.length - failed.length}/${results.length})` : `\nPASS (${results.length}/${results.length})`);
process.exit(failed.length ? 1 : 0);
