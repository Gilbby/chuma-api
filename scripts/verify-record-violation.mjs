// E2E verification of POST /api/penalties (manual violation recording).
// Issues a K1 "other" penalty to a member of the TEST group via the API,
// asserts the penalty + member notification were created with the right
// fields, exercises the validation/authorization failure paths, then removes
// the synthetic data. Safe to run repeatedly; uses K1.
//
// Usage: npm run verify:record-violation   (backend must be running on :5000)
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

const post = async (body, headers = H) => {
  const res = await fetch(`${API}/api/penalties`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const REASON = "Verification test violation (safe to delete)";
const base = { groupId: GROUP_ID, memberId: USER_ID, violationType: "other", reason: REASON, amount: AMOUNT };
let penaltyId = null;

try {
  // Happy path
  const ok = await post(base);
  console.log(`create: ${ok.status} ${JSON.stringify(ok.body).slice(0, 160)}`);
  const p = ok.body?.penalty;
  penaltyId = p?._id ?? null;
  check("201 created with penalty body", ok.status === 201 && !!p);
  check("penalty fields correct", p?.violationType === "other" && p?.reason === REASON && p?.amount === AMOUNT && p?.status === "pending");
  check("issuer recorded", String(p?.issuedBy) === USER_ID && !!p?.issuedByName);

  const notif = penaltyId
    ? await db.collection("notifications").findOne({ penaltyId: oid(penaltyId) })
    : null;
  check("member notification created", !!notif && String(notif.userId) === USER_ID && notif.type === "penalty");

  // Failure paths
  check("400 on invalid violation type", (await post({ ...base, violationType: "vandalism" })).status === 400);
  check("400 on zero amount", (await post({ ...base, amount: 0 })).status === 400);
  check("400 on missing reason", (await post({ ...base, reason: "  " })).status === 400);
  check("404 on non-member", (await post({ ...base, memberId: new mongoose.Types.ObjectId().toString() })).status === 404);
  check("401 without token", (await post(base, { "Content-Type": "application/json" })).status === 401);
} finally {
  // Cleanup synthetic data
  if (penaltyId) {
    await db.collection("penalties").deleteOne({ _id: oid(penaltyId) });
    await db.collection("notifications").deleteMany({ penaltyId: oid(penaltyId) });
    console.log(`cleaned up penalty ${penaltyId} + notifications`);
  }
  await mongoose.disconnect();
}

const failed = results.filter(([, c]) => !c);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
