// Verification for the platform-fee booking added to the settlement branches.
// Three synthetic scenarios, each proving the booking is (a) a side record that
// never contaminates the pool/wallet math, and (b) exactly-once under a
// replayed callback:
//
//   contribution — pool credited by EXACTLY base (K100), never the grossed-up
//                  deposit (K109) / base+fee (K102); fee booked source
//                  "contribution".
//   share-out    — pool decremented by the FULL owed/snapshot (K100), never the
//                  netReceived actually sent (K96); fee booked source "payout".
//   loan         — loanCirculation +FULL principal (K100) / walletBalance
//                  -FULL principal (K100). Chuma ABSORBS the provider fees so
//                  the borrower receives the full principal (depositAmount ===
//                  principal), and the absorbed cost books as NEGATIVE revenue
//                  (-K3), source "payout". No platform fee is charged.
//
// In all three, the booking is a side record touching no group/wallet/savings/
// circulation figure, and it books EXACTLY ONCE — a replayed callback reaching
// the settlement body again must not double-book, thanks to the unique+sparse
// transactionId index plus the 11000 swallow.
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
// Second, independent scenario for the share-out settlement branch.
const soGroupId = oid();
const soMemberId = oid();
const soTxnId = oid();
// Third, independent scenario for the loan settlement branch.
const lnGroupId = oid();
const lnMemberId = oid();
const lnTxnId = oid();
const lnLoanId = oid();
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

// Share-out group: member has a K100 stake to retire, pool holds it (100/100).
await db.collection("groups").insertOne({
  _id: soGroupId, name: "PLATFORM REVENUE SHAREOUT VERIFY (synthetic)", groupType: "savings-group",
  totalSavings: 100, walletBalance: 100, loanCirculation: 0, cycleProgress: 0.5,
  members: [{ userId: soMemberId, name: "Shareout member", role: "Member", status: "active", savings: 100, contributions: 1 }],
  status: "active", createdAt: now, updatedAt: now,
});
// Persist a real share-out transaction, as shareout.service writes it:
// amount = 100 (full owed — what the pool decrements by), depositAmount = 96
// (netReceived after fees, actually sent — must NOT drive the pool),
// platformFee = 2, meta.memberSavings = 100 (snapshot the branch zeroes to).
await db.collection("transactions").insertOne({
  _id: soTxnId, type: "share-out", status: "completed",
  amount: 100, depositAmount: 96, platformFee: 2,
  memberId: soMemberId, groupId: soGroupId, groupName: "PLATFORM REVENUE SHAREOUT VERIFY (synthetic)",
  note: "Cycle share-out", meta: { memberSavings: 100 },
  createdAt: now, updatedAt: now,
});

// Loan group: borrower is an active member; wallet holds float to lend from.
// Known starting values (loanCirculation 0, walletBalance 500) so the FULL-
// principal decrement/increment is observable.
await db.collection("groups").insertOne({
  _id: lnGroupId, name: "PLATFORM REVENUE LOAN VERIFY (synthetic)", groupType: "savings-group",
  totalSavings: 0, walletBalance: 500, loanCirculation: 0, cycleProgress: 0,
  members: [{ userId: lnMemberId, name: "Loan member", role: "Member", status: "active", savings: 0, contributions: 0, loanActive: 100 }],
  status: "active", createdAt: now, updatedAt: now,
});
// The loan branch resolves the loan via txn.meta.loanId with status "pending",
// activates it, and drives the group $inc off loan.principal / loan.outstanding.
await db.collection("loans").insertOne({
  _id: lnLoanId, groupId: lnGroupId, groupName: "PLATFORM REVENUE LOAN VERIFY (synthetic)",
  memberId: lnMemberId, memberName: "Loan member",
  principal: 100, outstanding: 100, installmentsPaid: 0, totalInstallments: 1,
  status: "pending", history: [], createdAt: now, updatedAt: now,
});
// Persist a real loan disbursement transaction, as approval.routes writes it:
// amount = 100 (full principal — drives circulation/wallet math), depositAmount
// = 100 (the borrower receives the FULL principal; Chuma absorbs the fees),
// platformFee = 0 (never charged on a disbursement), feesAbsorbed = 3 (the
// provider cost we ate), meta.loanId = the loan the branch activates.
await db.collection("transactions").insertOne({
  _id: lnTxnId, type: "loan", status: "completed",
  amount: 100, depositAmount: 100, platformFee: 0, feesAbsorbed: 3,
  memberId: lnMemberId, groupId: lnGroupId, groupName: "PLATFORM REVENUE LOAN VERIFY (synthetic)",
  note: "Loan disbursed", meta: { loanId: lnLoanId },
  createdAt: now, updatedAt: now,
});
console.log(`Seeded synthetic contribution ${txnId} (group ${groupId}), share-out ${soTxnId} (group ${soGroupId}), loan ${lnTxnId} (group ${lnGroupId})`);

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

  // ══ SHARE-OUT SCENARIO ══════════════════════════════════════════════════
  const soTxn = await db.collection("transactions").findOne({ _id: soTxnId });

  // ── 1. FIRST settle: pool decremented by the FULL owed/snapshot, not 96 ──
  await settleCompletedTransaction(soTxn);
  let sg = await db.collection("groups").findOne({ _id: soGroupId });
  let soMember = sg.members.find((m) => String(m.userId) === String(soMemberId));
  check("share-out: member savings zeroed (savings=0, contributions=0)",
    soMember.savings === 0 && soMember.contributions === 0,
    `savings=${soMember.savings} contributions=${soMember.contributions}`);
  check("share-out: totalSavings decremented by SNAPSHOT (100 → 0), not by 96",
    sg.totalSavings === 0, `totalSavings=${sg.totalSavings}`);
  check("share-out: walletBalance decremented by SHARE (100 → 0), not by 96",
    sg.walletBalance === 0, `walletBalance=${sg.walletBalance}`);

  // ── 2. PlatformRevenue side record: exactly one, K2, source "payout" ──
  let soRevDocs = await db.collection("platformrevenues").find({ transactionId: soTxnId }).toArray();
  check("share-out: exactly ONE PlatformRevenue doc booked for this txn",
    soRevDocs.length === 1, `count=${soRevDocs.length}`);
  check("share-out: PlatformRevenue amount=2, source=payout",
    soRevDocs.length === 1 && soRevDocs[0].amount === 2 && soRevDocs[0].source === "payout",
    `doc=${JSON.stringify(soRevDocs[0])}`);

  // ── 3. SECOND settle of the SAME share-out txn (replayed callback) ──
  // As in the contribution scenario, assert ONLY the booking's idempotency —
  // the pool $inc double-applying on a direct second call is expected and is
  // guarded upstream by the atomic pending→final guard, not by this branch.
  await settleCompletedTransaction(soTxn);
  soRevDocs = await db.collection("platformrevenues").find({ transactionId: soTxnId }).toArray();
  check("share-out: second settle does NOT double-book platform revenue (still exactly 1)",
    soRevDocs.length === 1, `count=${soRevDocs.length}`);

  // ══ LOAN SCENARIO ═══════════════════════════════════════════════════════
  const lnTxn = await db.collection("transactions").findOne({ _id: lnTxnId });

  // ── 1. FIRST settle: circulation/wallet move by the FULL principal ──
  await settleCompletedTransaction(lnTxn);
  let lg = await db.collection("groups").findOne({ _id: lnGroupId });
  const lnLoan = await db.collection("loans").findOne({ _id: lnLoanId });
  check("loan: activated (status pending → active)",
    lnLoan.status === "active", `status=${lnLoan.status}`);
  check("loan: loanCirculation +FULL principal (0 → 100)",
    lg.loanCirculation === 100, `loanCirculation=${lg.loanCirculation}`);
  check("loan: walletBalance -FULL principal (500 → 400) — the absorbed fee never touches the group",
    lg.walletBalance === 400, `walletBalance=${lg.walletBalance}`);

  // ── 2. PlatformRevenue side record: exactly one, NEGATIVE (a cost), payout ──
  let lnRevDocs = await db.collection("platformrevenues").find({ transactionId: lnTxnId }).toArray();
  check("loan: exactly ONE PlatformRevenue doc booked for this txn",
    lnRevDocs.length === 1, `count=${lnRevDocs.length}`);
  check("loan: PlatformRevenue amount=-3 (absorbed fee, a COST), source=payout",
    lnRevDocs.length === 1 && lnRevDocs[0].amount === -3 && lnRevDocs[0].source === "payout",
    `doc=${JSON.stringify(lnRevDocs[0])}`);

  // ── 3. SECOND settle of the SAME loan txn (replayed callback) ──
  // The loan branch's own atomic status pending→active claim already blocks the
  // circulation/wallet re-apply, so here we assert BOTH: no double-book AND the
  // loan booking stays exactly one.
  await settleCompletedTransaction(lnTxn);
  lnRevDocs = await db.collection("platformrevenues").find({ transactionId: lnTxnId }).toArray();
  check("loan: second settle does NOT double-book the absorbed fee (still exactly 1)",
    lnRevDocs.length === 1, `count=${lnRevDocs.length}`);
} finally {
  await db.collection("groups").deleteMany({ _id: { $in: [groupId, soGroupId, lnGroupId] } });
  await db.collection("transactions").deleteMany({ _id: { $in: [txnId, soTxnId, lnTxnId] } });
  await db.collection("loans").deleteOne({ _id: lnLoanId });
  await db.collection("platformrevenues").deleteMany({ transactionId: { $in: [txnId, soTxnId, lnTxnId] } });
  console.log("Cleanup done — synthetic platform-revenue documents removed.");
  await mongoose.disconnect();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\nFAIL (${results.length - failed.length}/${results.length})` : `\nPASS (${results.length}/${results.length})`);
process.exit(failed.length ? 1 : 0);
