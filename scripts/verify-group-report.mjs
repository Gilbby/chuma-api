// E2E verification of the extended GET /api/reports/:groupId analytics.
// Fetches the TEST group report, asserts the new fields (defaultRate,
// loansIssuedThisQuarter, memberConsistency) are present and well-formed,
// then seeds a synthetic disbursed loan (this quarter) and a synthetic
// overdue loan and asserts both KPIs move accordingly. Cleans up after.
//
// Usage: npm run verify:group-report   (backend must be running on :5000)
import "dotenv/config";
import dns from "dns";
// The local router's DNS intermittently SERVFAILs TXT/SRV lookups; bypass it.
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.promises.setServers(["8.8.8.8", "1.1.1.1"]);
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

const GROUP_ID = "6a47ce19b993fc0dbfd4c379";
const USER_ID = "6a47cb8be9d07482567dfcc0"; // Gilbert — Chairperson of TEST
const API = "http://localhost:5000";

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
const H = { Authorization: `Bearer ${token}` };
const oid = (s) => new mongoose.Types.ObjectId(s);

const results = [];
const check = (name, cond) => { results.push([name, cond]); console.log(`${cond ? "PASS" : "FAIL"}: ${name}`); };

const getReport = async () => {
  const res = await fetch(`${API}/api/reports/${GROUP_ID}`, { headers: H });
  if (res.status !== 200) throw new Error(`report fetch failed: ${res.status}`);
  return res.json();
};

const seededLoanIds = [];
try {
  // Baseline shape
  const before = await getReport();
  console.log(
    `baseline: loansIssuedThisQuarter=${before.loansIssuedThisQuarter} defaultRate=${before.defaultRate} members=${before.memberConsistency?.length}`
  );
  check("has loansIssuedThisQuarter (number)", typeof before.loansIssuedThisQuarter === "number");
  check("has defaultRate (number 0-100)", typeof before.defaultRate === "number" && before.defaultRate >= 0 && before.defaultRate <= 100);
  check("has memberConsistency array", Array.isArray(before.memberConsistency) && before.memberConsistency.length > 0);
  const me = before.memberConsistency?.find((m) => m.userId === USER_ID);
  check(
    "consistency entry well-formed (rate null or 0-100)",
    !!me && typeof me.name === "string" && (me.rate === null || (me.rate >= 0 && me.rate <= 100))
  );

  // Seed a repaid loan disbursed this quarter (K7) → KPI should rise by 7
  const now = new Date();
  const disbursed = await db.collection("loans").insertOne({
    groupId: oid(GROUP_ID), groupName: "TEST", memberId: oid(USER_ID), memberName: "Gilbert",
    principal: 7, outstanding: 0, interestRate: 0, durationMonths: 1,
    installmentsPaid: 1, totalInstallments: 1, status: "repaid",
    history: [{ date: now, amount: 7, type: "disbursement" }],
    createdAt: now, updatedAt: now,
  });
  seededLoanIds.push(disbursed.insertedId);

  // Seed an active overdue loan (outstanding K3, due yesterday) → defaults
  const overdue = await db.collection("loans").insertOne({
    groupId: oid(GROUP_ID), groupName: "TEST", memberId: oid(USER_ID), memberName: "Gilbert",
    principal: 3, outstanding: 3, interestRate: 0, durationMonths: 1,
    installmentsPaid: 0, totalInstallments: 1, status: "active",
    nextDueDate: new Date(Date.now() - 86400000),
    history: [{ date: now, amount: 3, type: "disbursement" }],
    createdAt: now, updatedAt: now,
  });
  seededLoanIds.push(overdue.insertedId);

  const after = await getReport();
  console.log(
    `after seed: loansIssuedThisQuarter=${after.loansIssuedThisQuarter} defaultRate=${after.defaultRate} defaults=${after.defaults}`
  );
  check(
    "loansIssuedThisQuarter rose by seeded disbursements (7+3)",
    after.loansIssuedThisQuarter === before.loansIssuedThisQuarter + 10
  );
  check("defaultRate rose with overdue loan", after.defaultRate > 0 && after.defaultRate >= before.defaultRate);
  check("defaults count includes overdue loan", after.defaults >= before.defaults + 1);
} finally {
  if (seededLoanIds.length) {
    await db.collection("loans").deleteMany({ _id: { $in: seededLoanIds } });
    console.log(`cleaned up ${seededLoanIds.length} synthetic loans`);
  }
  await mongoose.disconnect();
}

const failed = results.filter(([, c]) => !c);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
