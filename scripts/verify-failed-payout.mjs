// E2E verification of the FAILED-payout branch of handleFailedTransaction.
// Seeds a synthetic member whose phone is PawaPay's Airtel sandbox
// RECIPIENT_NOT_FOUND payout number, then drives the REAL flow: loan request
// → admin approval → PawaPay disbursement payout → FAILED callback. Asserts
// the loan stays pending, group balances don't move, the borrower gets the
// "could not be sent to your wallet" notification, and each admin gets a
// retryable notification carrying the transactionId. Cleans up all synthetic
// data. Safe to run repeatedly; uses K1.
//
// Usage: npm run verify:failed-payout   (backend must be running on :5000)
import "dotenv/config";
import dns from "dns";
// The local router's DNS intermittently SERVFAILs TXT/SRV lookups; bypass it.
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.promises.setServers(["8.8.8.8", "1.1.1.1"]);
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

const GROUP_ID = "6a47ce19b993fc0dbfd4c379";
const ADMIN_ID = "6a47cb8be9d07482567dfcc0"; // Gilbert — Chairperson of TEST
const API = "http://localhost:5000";
const AMOUNT = 1;
// Airtel Zambia sandbox payout number that always fails (RECIPIENT_NOT_FOUND).
// NB: distinct from the deposit-failure numbers — see docs.pawapay.io test numbers.
const FAIL_PAYOUT_PHONE = "260973456089";
const TEST_NAME = "Payout Fail Test";

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
const db = mongoose.connection.db;
const oid = (s) => new mongoose.Types.ObjectId(s);
const sign = (uid) => jwt.sign({ uid }, process.env.JWT_SECRET, { expiresIn: "1h" });
const headers = (uid) => ({ "Content-Type": "application/json", Authorization: `Bearer ${sign(uid)}` });

const results = [];
const check = (name, cond) => { results.push([name, cond]); console.log(`${cond ? "PASS" : "FAIL"}: ${name}`); };

// ── Seed: synthetic borrower who is an active member of TEST ──
const userRes = await db.collection("users").insertOne({
  name: TEST_NAME, phone: FAIL_PAYOUT_PHONE, trustScore: 70,
  kyc: { status: "incomplete" }, joinedDate: new Date(),
  createdAt: new Date(), updatedAt: new Date(),
});
const userId = userRes.insertedId;
await db.collection("groups").updateOne(
  { _id: oid(GROUP_ID) },
  { $push: { members: {
    userId, name: TEST_NAME, phone: FAIL_PAYOUT_PHONE, role: "Member",
    status: "active", savings: 50, contributions: 0, loanActive: 0,
  } } }
);
console.log(`Seeded user ${userId} as active member of TEST (phone ${FAIL_PAYOUT_PHONE})`);

const before = await db.collection("groups").findOne({ _id: oid(GROUP_ID) },
  { projection: { walletBalance: 1, loanCirculation: 1, totalSavings: 1 } });

let loanId = null, approvalId = null, txnId = null;
try {
  // ── Real flow: request loan as the synthetic member ──
  const loanRes = await fetch(`${API}/api/loans`, {
    method: "POST", headers: headers(String(userId)),
    body: JSON.stringify({ groupId: GROUP_ID, amount: AMOUNT, durationMonths: 1, reason: "verify failed payout" }),
  });
  const loanBody = await loanRes.json();
  check("loan request accepted", loanRes.status === 201 && !!loanBody.loan);
  loanId = loanBody.loan?._id;
  approvalId = loanBody.approval?._id;

  // ── Approve as Gilbert (sole admin → majority reached → disburses) ──
  let executed = null;
  if (approvalId) {
    const voteRes = await fetch(`${API}/api/approvals/${approvalId}/vote`, {
      method: "POST", headers: headers(ADMIN_ID),
      body: JSON.stringify({ decision: "approve" }),
    });
    const voteBody = await voteRes.json();
    executed = voteBody.executed;
    console.log(`vote: ${voteRes.status} executed=${JSON.stringify(executed)}`);
  }
  check("approval executed a real (non-simulated) disbursement",
    executed?.type === "loan-disbursement-initiated" && !!executed?.payoutId);

  // ── Wait for the FAILED callback (cron reconciliation as backstop) ──
  let txn = null, finalStatus = "pending";
  if (executed?.payoutId) {
    const t0 = Date.now();
    while (Date.now() - t0 < 8.5 * 60 * 1000) {
      txn = await db.collection("transactions").findOne({ "pawapay.payoutId": executed.payoutId });
      if (txn && txn.status !== "pending") { finalStatus = txn.status; break; }
      await new Promise((r) => setTimeout(r, 5000));
    }
    txnId = txn?._id ?? null;
    console.log(`disbursement settled: ${finalStatus} after ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  check("disbursement transaction FAILED", finalStatus === "failed" && txn?.pawapay?.status === "FAILED");
  check("failure reason recorded (RECIPIENT_NOT_FOUND)",
    (txn?.pawapay?.failureReason || "").includes("RECIPIENT_NOT_FOUND"));

  const loanAfter = loanId ? await db.collection("loans").findOne({ _id: oid(loanId) }) : null;
  check("loan stays pending (never activated)", loanAfter?.status === "pending");

  const after = await db.collection("groups").findOne({ _id: oid(GROUP_ID) },
    { projection: { walletBalance: 1, loanCirculation: 1, totalSavings: 1 } });
  check("group balances unchanged",
    after.walletBalance === before.walletBalance &&
    after.loanCirculation === before.loanCirculation &&
    after.totalSavings === before.totalSavings);

  const memberNotif = await db.collection("notifications").findOne(
    { userId, title: "Loan disbursement failed" });
  check("borrower notified: could not be sent to wallet, admins will retry",
    !!memberNotif && /could not be sent to your wallet/.test(memberNotif.body));

  const adminNotif = txnId ? await db.collection("notifications").findOne(
    { userId: oid(ADMIN_ID), transactionId: txnId }) : null;
  check("admin notified with transactionId (retryable) naming the member",
    !!adminNotif && /please retry/.test(adminNotif.body) && adminNotif.body.includes(TEST_NAME));
} finally {
  // Cleanup always runs, even if assertions or the network blew up above.
  await db.collection("groups").updateOne(
    { _id: oid(GROUP_ID) }, { $pull: { members: { userId } } });
  await db.collection("users").deleteOne({ _id: userId });
  if (loanId) await db.collection("loans").deleteOne({ _id: oid(loanId) });
  if (approvalId) await db.collection("approvals").deleteOne({ _id: oid(approvalId) });
  if (txnId) await db.collection("transactions").deleteOne({ _id: txnId });
  await db.collection("notifications").deleteMany({ userId }); // borrower's
  if (txnId) await db.collection("notifications").deleteMany({ transactionId: txnId });
  await db.collection("notifications").deleteMany({ body: new RegExp(TEST_NAME) });
  console.log("Cleanup done — synthetic user/member/loan/approval/txn/notifications removed.");
  await mongoose.disconnect();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failed.length ? 1 : 0);
