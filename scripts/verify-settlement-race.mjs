// Concurrency regression test for settleCompletedTransaction.
// The share-out settlement race (concurrent callbacks clobbering each other's
// read-modify-write group.save()) proved this failure mode is real, not
// hypothetical. This script drives the OTHER settlement branches with
// deliberately concurrent calls against synthetic Atlas documents and asserts
// each effect is applied exactly once / never lost:
//   fee        — two concurrent 1-month fees must advance feePaidThrough 2 months
//   penalty    — two txns for the same penalty must credit the pool once
//   repayment  — two overlapping repayments must clamp to outstanding, and a
//                contribution settling in the same window must not be erased
//   loan       — a duplicate disbursement settlement must not double-apply
// Runs directly against the service (no HTTP); cleans up everything.
//
// Usage: npm run verify:settlement-race
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
const db = mongoose.connection.db;
const oid = () => new mongoose.Types.ObjectId();

const results = [];
const check = (name, cond, detail = "") => {
  results.push([name, cond]);
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}${cond ? "" : ` — ${detail}`}`);
};

const groupId = oid();
const memberId = oid();
const loanIdRepay = oid();
const loanIdDisb = oid();
const penaltyId = oid();
const now = new Date();
const feeBase = new Date("2026-07-01T00:00:00Z");

await db.collection("groups").insertOne({
  _id: groupId, name: "RACE VERIFY (synthetic)", groupType: "savings-group",
  totalSavings: 100, walletBalance: 100, loanCirculation: 10,
  feePaidThrough: feeBase, cycleProgress: 0.5,
  members: [{ userId: memberId, name: "Race member", role: "Member", status: "active", savings: 100, contributions: 1, loanActive: 10 }],
  status: "active", createdAt: now, updatedAt: now,
});
await db.collection("loans").insertOne({
  _id: loanIdRepay, groupId, groupName: "RACE VERIFY (synthetic)", memberId, memberName: "Race member",
  principal: 10, outstanding: 10, installmentsPaid: 0, totalInstallments: 2,
  status: "active", history: [], createdAt: now, updatedAt: now,
});
await db.collection("loans").insertOne({
  _id: loanIdDisb, groupId, groupName: "RACE VERIFY (synthetic)", memberId, memberName: "Race member",
  principal: 5, outstanding: 5, installmentsPaid: 0, totalInstallments: 1,
  status: "pending", history: [], createdAt: now, updatedAt: now,
});
await db.collection("penalties").insertOne({
  _id: penaltyId, groupId, memberId, memberName: "Race member", type: "other",
  amount: 5, fundsDestination: "group-pool", status: "pending", createdAt: now, updatedAt: now,
});
console.log(`Seeded synthetic group ${groupId}`);

try {
  // ── fee: two concurrent 1-month settlements → +2 months, none lost ──
  await Promise.all([
    settleCompletedTransaction({ _id: oid(), type: "fee", groupId, meta: { months: 1 } }),
    settleCompletedTransaction({ _id: oid(), type: "fee", groupId, meta: { months: 1 } }),
  ]);
  let g = await db.collection("groups").findOne({ _id: groupId });
  const expected = new Date(feeBase); expected.setMonth(expected.getMonth() + 2);
  check("fee: concurrent settlements advance 2 months (none lost)",
    new Date(g.feePaidThrough).getTime() === expected.getTime(),
    `feePaidThrough=${g.feePaidThrough}`);

  // ── penalty: two txns for the same penalty → pool credited once ──
  await Promise.all([
    settleCompletedTransaction({ _id: oid(), type: "penalty", groupId, meta: { penaltyId } }),
    settleCompletedTransaction({ _id: oid(), type: "penalty", groupId, meta: { penaltyId } }),
  ]);
  g = await db.collection("groups").findOne({ _id: groupId });
  const pen = await db.collection("penalties").findOne({ _id: penaltyId });
  check("penalty: credited to pool exactly once (+5, not +10)",
    g.walletBalance === 105 && g.totalSavings === 105 && pen.status === "paid",
    `wallet=${g.walletBalance} totalSavings=${g.totalSavings}`);

  // ── repayment: two overlapping K6 repayments against K10 outstanding,
  //    with a K7 contribution settling in the same window ──
  await Promise.all([
    settleCompletedTransaction({ _id: oid(), type: "repayment", groupId, memberId, amount: -6, meta: { loanId: loanIdRepay } }),
    settleCompletedTransaction({ _id: oid(), type: "repayment", groupId, memberId, amount: -6, meta: { loanId: loanIdRepay } }),
    settleCompletedTransaction({ _id: oid(), type: "contribution", groupId, memberId, amount: -7 }),
  ]);
  g = await db.collection("groups").findOne({ _id: groupId });
  const loanR = await db.collection("loans").findOne({ _id: loanIdRepay });
  check("repayment: clamped to outstanding (repaid, 0 left, history sums to 10)",
    loanR.status === "repaid" && loanR.outstanding === 0 &&
    loanR.history.reduce((s, h) => s + h.amount, 0) === 10,
    `status=${loanR.status} outstanding=${loanR.outstanding} history=${JSON.stringify(loanR.history)}`);
  // wallet: 105 + 10 (repaid, clamped) + 7 (contribution) = 122 — the
  // concurrent contribution's $inc must survive the repayment settlement.
  check("repayment: wallet +10 and concurrent contribution +7 both applied (122)",
    g.walletBalance === 122, `wallet=${g.walletBalance}`);
  check("repayment: loanCirculation drawn to 0 (clamped, not negative)",
    g.loanCirculation === 0, `loanCirculation=${g.loanCirculation}`);

  // ── loan: duplicate disbursement settlements → applied once ──
  await Promise.all([
    settleCompletedTransaction({ _id: oid(), type: "loan", groupId, memberId, amount: 5, meta: { loanId: loanIdDisb } }),
    settleCompletedTransaction({ _id: oid(), type: "loan", groupId, memberId, amount: 5, meta: { loanId: loanIdDisb } }),
  ]);
  g = await db.collection("groups").findOne({ _id: groupId });
  const loanD = await db.collection("loans").findOne({ _id: loanIdDisb });
  check("loan: activated exactly once (single history entry)",
    loanD.status === "active" && loanD.history.length === 1,
    `status=${loanD.status} history=${loanD.history.length}`);
  check("loan: circulation +5 once, wallet -5 once (5 / 117)",
    g.loanCirculation === 5 && g.walletBalance === 117,
    `loanCirculation=${g.loanCirculation} wallet=${g.walletBalance}`);
} finally {
  await db.collection("groups").deleteOne({ _id: groupId });
  await db.collection("loans").deleteMany({ _id: { $in: [loanIdRepay, loanIdDisb] } });
  await db.collection("penalties").deleteOne({ _id: penaltyId });
  await db.collection("notifications").deleteMany({ groupId });
  console.log("Cleanup done — synthetic race-test documents removed.");
  await mongoose.disconnect();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failed.length ? 1 : 0);
