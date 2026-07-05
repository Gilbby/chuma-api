// E2E verification of POST /api/transactions/:id/retry-payout.
// Seeds a synthetic pending loan + FAILED disbursement in the TEST group,
// retries it via the API, asserts the double-retry guard, waits for the payout
// to settle, then removes all synthetic data (reverting group balances if the
// payout completed). Safe to run repeatedly; uses K1.
//
// Usage: npm run verify:retry-payout   (backend must be running on :5000)
import "dotenv/config";
import dns from "dns";
// The local router's DNS intermittently SERVFAILs TXT/SRV lookups; bypass it.
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.promises.setServers(["8.8.8.8", "1.1.1.1"]);
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";

const GROUP_ID = "6a47ce19b993fc0dbfd4c379";
const USER_ID = "6a47cb8be9d07482567dfcc0"; // Gilbert — Chairperson of TEST
const API = "http://localhost:5000";
const AMOUNT = 1;

// Tolerate a flaky route to Atlas: retry the initial connection.
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
const token = jwt.sign({ uid: USER_ID }, process.env.JWT_SECRET, { expiresIn: "1h" });
const H = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
const oid = (s) => new mongoose.Types.ObjectId(s);

const results = [];
const check = (name, cond) => { results.push([name, cond]); console.log(`${cond ? "PASS" : "FAIL"}: ${name}`); };

const loanRes = await db.collection("loans").insertOne({
  groupId: oid(GROUP_ID), groupName: "TEST", memberId: oid(USER_ID), memberName: "Gilbert",
  principal: AMOUNT, outstanding: AMOUNT, interestRate: 0, durationMonths: 1,
  installmentsPaid: 0, totalInstallments: 1, status: "pending", history: [],
  createdAt: new Date(), updatedAt: new Date(),
});
const loanId = loanRes.insertedId;
const failedRes = await db.collection("transactions").insertOne({
  groupId: oid(GROUP_ID), groupName: "TEST", memberId: oid(USER_ID), memberName: "Gilbert",
  type: "loan", amount: AMOUNT, status: "failed", note: "Loan disbursed",
  receiptId: "CHM-TESTFAIL", pawapay: { payoutId: randomUUID(), status: "FAILED" },
  meta: { loanId }, date: new Date(), createdAt: new Date(), updatedAt: new Date(),
});
const failedId = failedRes.insertedId;
console.log(`Seeded pending loan ${loanId} + failed txn ${failedId}`);

const groupBefore = await db.collection("groups").findOne({ _id: oid(GROUP_ID) },
  { projection: { walletBalance: 1, loanCirculation: 1 } });

let body, status;
let retryTxnId = null;
let finalStatus = "pending";
try {
  // Provider timeouts return 402 and release the claim, so retrying is safe.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${API}/api/transactions/${failedId}/retry-payout`, { method: "POST", headers: H });
      status = res.status;
      body = await res.json();
      console.log(`retry attempt ${attempt}: ${status} ${JSON.stringify(body).slice(0, 140)}`);
      if (status !== 402) break;
    } catch (e) {
      console.log(`retry attempt ${attempt}: fetch error ${e.message} — is the backend running?`);
    }
    await new Promise((r) => setTimeout(r, 8000));
  }
  const retryOk = status === 200 && body?.transaction;
  check("retry accepted, new pending txn created", !!retryOk && body.transaction.status === "pending");
  retryTxnId = body?.transaction?._id ?? null;
  check("retry carries meta.loanId + retryOf", !!retryOk &&
    String(body.transaction.meta?.loanId) === String(loanId) &&
    String(body.transaction.meta?.retryOf) === String(failedId));

  if (retryOk) {
    const res2 = await fetch(`${API}/api/transactions/${failedId}/retry-payout`, { method: "POST", headers: H });
    const body2 = await res2.json().catch(() => ({}));
    console.log(`second retry: ${res2.status} ${JSON.stringify(body2).slice(0, 100)}`);
    // 409 = atomic already-retried claim. 400 = the first retry's payout
    // already settled and activated the loan before this call — normal now
    // that callbacks land in ~1s. Either way the double-spend was refused.
    check("second retry rejected (409 already-retried / 400 already-settled)",
      res2.status === 409 || (res2.status === 400 && /already/i.test(body2?.error || "")));

    const t0 = Date.now();
    while (Date.now() - t0 < 8.5 * 60 * 1000) {
      const t = await db.collection("transactions").findOne({ _id: oid(retryTxnId) }, { projection: { status: 1 } });
      if (t.status !== "pending") { finalStatus = t.status; break; }
      await new Promise((r) => setTimeout(r, 10000));
    }
    console.log(`retry payout settled: ${finalStatus} after ${Math.round((Date.now() - t0) / 1000)}s`);

    const loanAfter = await db.collection("loans").findOne({ _id: loanId });
    if (finalStatus === "completed") {
      check("loan activated on settlement", loanAfter.status === "active");
      const ga = await db.collection("groups").findOne({ _id: oid(GROUP_ID) },
        { projection: { walletBalance: 1, loanCirculation: 1 } });
      check("group circulation +1 / wallet -1",
        ga.loanCirculation === groupBefore.loanCirculation + AMOUNT &&
        ga.walletBalance === groupBefore.walletBalance - AMOUNT);
    } else if (finalStatus === "failed") {
      console.log("Payout FAILED at provider — verifying failure path.");
      check("loan stays pending on failed retry", loanAfter.status === "pending");
      const notif = await db.collection("notifications").findOne(
        { transactionId: oid(retryTxnId) }, { sort: { createdAt: -1 } });
      check("failure notification carries transactionId (retryable again)", !!notif);
    } else {
      check("payout settled within window", false);
    }
  }
} finally {
  // Cleanup always runs, even if assertions or the network blew up above.
  await db.collection("transactions").deleteMany({ _id: { $in: [failedId, ...(retryTxnId ? [oid(retryTxnId)] : [])] } });
  await db.collection("loans").deleteOne({ _id: loanId });
  await db.collection("notifications").deleteMany({ transactionId: { $in: [failedId, ...(retryTxnId ? [oid(retryTxnId)] : [])] } });
  await db.collection("notifications").deleteMany({ body: /K1 has been sent to your mobile wallet/ });
  if (finalStatus === "completed") {
    await db.collection("groups").updateOne(
      { _id: oid(GROUP_ID) },
      { $inc: { loanCirculation: -AMOUNT, walletBalance: AMOUNT },
        $set: { "members.$[m].loanActive": 0 } },
      { arrayFilters: [{ "m.userId": oid(USER_ID) }] }
    );
  }
  console.log("Cleanup done — synthetic loan/txns/notifications removed.");
  await mongoose.disconnect();
}

const failedChecks = results.filter(([, ok]) => !ok);
console.log(failedChecks.length ? `\n${failedChecks.length} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failedChecks.length ? 1 : 0);
