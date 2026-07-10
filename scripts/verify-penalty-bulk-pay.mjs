// Verification for paying SEVERAL penalties in one deposit (POST /penalties/pay)
// and the settlement branch that clears them.
//
// Exercises the REAL settlement service against real Mongo documents:
//
//   batch      — one "penalty" txn carrying meta.penaltyIds clears EVERY listed
//                penalty (status → paid) and credits the pool by the sum of the
//                group-pool ones ONLY. A welfare-account penalty is marked paid
//                but must NOT reach walletBalance/totalSavings.
//   replay     — settling the SAME txn again must not re-credit the pool: each
//                penalty is claimed atomically (status ≠ paid), so a replayed
//                callback finds nothing left to claim.
//   partial    — a penalty already settled by another txn is skipped, while the
//                rest of the batch still credits exactly once.
//   legacy     — the old single-pay shape (meta.penaltyId) still settles, so
//                transactions pending when the batch endpoint shipped drain fine.
//   objectid   — meta.penaltyIds round-trips through the Mixed field and still
//                matches by _id after being read back from Mongo.
//
// Runs directly against the service (no HTTP); cleans up everything.
//
// Usage: npm run verify:penalty-bulk-pay
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
  console.error("Could not reach Mongo — network problem. Re-run later.");
  process.exit(2);
}
const { settleCompletedTransaction } = await import("../src/services/settlement.service.js");
const db = mongoose.connection.db;
const oid = () => new mongoose.Types.ObjectId();

const results = [];
const check = (name, cond, detail = "") => {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` — ${detail}`}`);
};

const groupId = oid();
const memberId = oid();
const txnId = oid();       // batch of 3
const legacyTxnId = oid(); // old single-pay shape
const partialTxnId = oid();
const now = new Date();

// Three penalties: two routed to the group pool (K50 + K30 = K80 pooled),
// one to the welfare account (K20 — paid, but never pooled).
const penPool1 = oid();
const penPool2 = oid();
const penWelfare = oid();
const penLegacy = oid();
const penPartialA = oid(); // will be pre-settled by another txn
const penPartialB = oid();

const GROUP = "PENALTY BULK PAY VERIFY (synthetic)";

const mkPenalty = (_id, amount, fundsDestination, reason) => ({
  _id, groupId, groupName: GROUP, memberId, memberName: "Penalty member",
  violationType: "lateContribution", reason, amount, fundsDestination,
  status: "pending", createdAt: now, updatedAt: now,
});

await db.collection("groups").insertOne({
  _id: groupId, name: GROUP, groupType: "savings-group",
  totalSavings: 0, walletBalance: 0, loanCirculation: 0, cycleProgress: 0,
  members: [{ userId: memberId, name: "Penalty member", role: "Member", status: "active", savings: 0, contributions: 0 }],
  status: "active", createdAt: now, updatedAt: now,
});
await db.collection("penalties").insertMany([
  mkPenalty(penPool1, 50, "group-pool", "Late contribution"),
  mkPenalty(penPool2, 30, "group-pool", "Missed meeting"),
  mkPenalty(penWelfare, 20, "welfare-account", "Late repayment"),
  mkPenalty(penLegacy, 15, "group-pool", "Legacy single pay"),
  mkPenalty(penPartialA, 40, "group-pool", "Partial A"),
  mkPenalty(penPartialB, 60, "group-pool", "Partial B"),
]);

// The batch transaction exactly as POST /penalties/pay writes it: amount is the
// NEGATIVE sum of every penalty (money out of the member's wallet), and
// meta.penaltyIds carries the ObjectIds.
await db.collection("transactions").insertOne({
  _id: txnId, type: "penalty", status: "completed",
  amount: -(50 + 30 + 20),
  memberId, groupId, groupName: GROUP,
  note: "3 penalties", receiptId: "CHM-VERIFY-1",
  meta: { penaltyIds: [penPool1, penPool2, penWelfare] },
  createdAt: now, updatedAt: now,
});
// Legacy single-pay shape, as POST /penalties/:id/pay writes it.
await db.collection("transactions").insertOne({
  _id: legacyTxnId, type: "penalty", status: "completed",
  amount: -15, memberId, groupId, groupName: GROUP,
  note: "Penalty: Legacy single pay", receiptId: "CHM-VERIFY-2",
  meta: { penaltyId: penLegacy },
  createdAt: now, updatedAt: now,
});
// Partial batch: A is pre-settled below by a different txn, B is still pending.
await db.collection("transactions").insertOne({
  _id: partialTxnId, type: "penalty", status: "completed",
  amount: -(40 + 60), memberId, groupId, groupName: GROUP,
  note: "2 penalties", receiptId: "CHM-VERIFY-3",
  meta: { penaltyIds: [penPartialA, penPartialB] },
  createdAt: now, updatedAt: now,
});
console.log(`Seeded group ${groupId} with 6 penalties and 3 penalty transactions`);

try {
  // ══ BATCH ═══════════════════════════════════════════════════════════════
  // Read the txn back from Mongo — this is the object the callback path hands
  // to the service, and it proves meta.penaltyIds survives the Mixed round-trip.
  const txn = await db.collection("transactions").findOne({ _id: txnId });
  check("meta.penaltyIds survives the Mixed round-trip (3 ids read back)",
    Array.isArray(txn.meta?.penaltyIds) && txn.meta.penaltyIds.length === 3,
    `meta=${JSON.stringify(txn.meta)}`);

  await settleCompletedTransaction(txn);

  const paid = await db.collection("penalties")
    .find({ _id: { $in: [penPool1, penPool2, penWelfare] } }).toArray();
  check("batch: ALL THREE penalties marked paid",
    paid.length === 3 && paid.every((p) => p.status === "paid"),
    paid.map((p) => `${p.reason}:${p.status}`).join(" "));

  let g = await db.collection("groups").findOne({ _id: groupId });
  check("batch: pool credited by the GROUP-POOL sum only (walletBalance=80, not 100)",
    g.walletBalance === 80, `walletBalance=${g.walletBalance}`);
  check("batch: totalSavings=80 — the welfare-account K20 did NOT reach the pool",
    g.totalSavings === 80, `totalSavings=${g.totalSavings}`);

  const welfare = await db.collection("penalties").findOne({ _id: penWelfare });
  check("batch: welfare-account penalty is paid but unpooled",
    welfare.status === "paid", `status=${welfare.status}`);

  // ══ REPLAY ══════════════════════════════════════════════════════════════
  // A replayed callback reaching the settlement body again must not re-credit.
  // Every penalty is already "paid", so each atomic claim returns null.
  await settleCompletedTransaction(txn);
  g = await db.collection("groups").findOne({ _id: groupId });
  check("replay: pool NOT double-credited (walletBalance still 80)",
    g.walletBalance === 80, `walletBalance=${g.walletBalance}`);
  check("replay: totalSavings still 80",
    g.totalSavings === 80, `totalSavings=${g.totalSavings}`);

  // ══ LEGACY SINGLE-PAY SHAPE ═════════════════════════════════════════════
  const legacyTxn = await db.collection("transactions").findOne({ _id: legacyTxnId });
  await settleCompletedTransaction(legacyTxn);
  const legacyPen = await db.collection("penalties").findOne({ _id: penLegacy });
  g = await db.collection("groups").findOne({ _id: groupId });
  check("legacy: meta.penaltyId (single) still settles → paid",
    legacyPen.status === "paid", `status=${legacyPen.status}`);
  check("legacy: pool credited by 15 (80 → 95)",
    g.walletBalance === 95, `walletBalance=${g.walletBalance}`);

  // ══ PARTIAL BATCH ═══════════════════════════════════════════════════════
  // Pre-settle penalty A out from under the batch (as a concurrent single-pay
  // txn would). The batch must skip A and still credit B exactly once.
  await db.collection("penalties").updateOne({ _id: penPartialA }, { $set: { status: "paid" } });
  const partialTxn = await db.collection("transactions").findOne({ _id: partialTxnId });
  await settleCompletedTransaction(partialTxn);
  g = await db.collection("groups").findOne({ _id: groupId });
  const partialB = await db.collection("penalties").findOne({ _id: penPartialB });
  check("partial: already-paid penalty A skipped, B still settled → paid",
    partialB.status === "paid", `B status=${partialB.status}`);
  check("partial: pool credited by B ONLY (95 → 155, not 195 — A's K40 not re-credited)",
    g.walletBalance === 155, `walletBalance=${g.walletBalance}`);

  // ══ EMPTY META ══════════════════════════════════════════════════════════
  // A penalty txn with no ids must be a no-op, never a crash.
  const before = (await db.collection("groups").findOne({ _id: groupId })).walletBalance;
  await settleCompletedTransaction({ _id: oid(), type: "penalty", groupId, meta: {} });
  const after = (await db.collection("groups").findOne({ _id: groupId })).walletBalance;
  check("empty meta: no-op, no crash, pool unchanged", before === after, `${before} → ${after}`);
} finally {
  await db.collection("groups").deleteOne({ _id: groupId });
  await db.collection("penalties").deleteMany({ groupId });
  await db.collection("transactions").deleteMany({ _id: { $in: [txnId, legacyTxnId, partialTxnId] } });
  console.log("Cleanup done — synthetic penalty documents removed.");
  await mongoose.disconnect();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\nFAIL (${results.length - failed.length}/${results.length})` : `\nPASS (${results.length}/${results.length})`);
process.exit(failed.length ? 1 : 0);
