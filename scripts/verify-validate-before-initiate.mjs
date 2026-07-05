// E2E verification that money routes validate the WHOLE request before
// telling PawaPay to move money (the "orphaned deposit" fix). Drives a
// dedicated API instance whose stdout is captured to LOG_PATH, and counts
// "[PAYMENT SIMULATED] DEPOSIT" lines around each call: an invalid request
// must produce a 400 with ZERO deposit initiations (previously the deposit
// was initiated first and the Mongoose enum check rejected it after), while
// a valid request still initiates exactly one and settles normally.
// Cleans up all synthetic data. Safe to run repeatedly; uses K1.
//
// Usage: LOG_PATH=<server log> API_URL=http://localhost:5054 \
//        node scripts/verify-validate-before-initiate.mjs
//        (start the API with PAYMENTS_ENABLED=false, stdout → LOG_PATH)
import "dotenv/config";
import fs from "fs";
import dns from "dns";
// The local router's DNS intermittently SERVFAILs TXT/SRV lookups; bypass it.
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.promises.setServers(["8.8.8.8", "1.1.1.1"]);
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

const GROUP_ID = "6a47ce19b993fc0dbfd4c379"; // TEST group
const API = process.env.API_URL || "http://localhost:5054";
const LOG_PATH = process.env.LOG_PATH;
const TEST_NAME = "Validate First Test";
const TEST_PHONE = "260971110001"; // Airtel prefix — valid provider mapping

if (!LOG_PATH) {
  console.error("LOG_PATH must point at the API instance's captured stdout");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const depositCount = () =>
  (fs.readFileSync(LOG_PATH, "utf8").match(/\[PAYMENT SIMULATED\] DEPOSIT/g) || []).length;

let connected = false;
for (let i = 1; i <= 5 && !connected; i++) {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
    connected = true;
  } catch (e) {
    console.log(`mongo connect attempt ${i} failed: ${e.message} — retrying in 10s`);
    await sleep(10000);
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

// ── Seed: synthetic contributor who is an active member of TEST ──
const userRes = await db.collection("users").insertOne({
  name: TEST_NAME, phone: TEST_PHONE, trustScore: 70,
  kyc: { status: "incomplete" }, joinedDate: new Date(),
  createdAt: new Date(), updatedAt: new Date(),
});
const userId = userRes.insertedId;
await db.collection("groups").updateOne(
  { _id: oid(GROUP_ID) },
  { $push: { members: {
    userId, name: TEST_NAME, phone: TEST_PHONE, role: "Member",
    status: "active", savings: 0, contributions: 0, loanActive: 0,
  } } }
);
console.log(`Seeded user ${userId} as active member of TEST`);

const post = async (path, uid, body) => {
  const res = await fetch(`${API}/api${path}`, {
    method: "POST", headers: headers(uid), body: JSON.stringify(body),
  });
  let json = {};
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
};

let mobileSettled = false;
const txnIds = [];
try {
  // ── 1. Bad paymentMethod enum (the original drill payload) ──
  let before = depositCount();
  let r = await post("/contributions", String(userId), {
    groupId: GROUP_ID, amount: 1, contributionType: "topup",
    paymentMethod: "Mobile Money", payerPhone: TEST_PHONE,
  });
  await sleep(400);
  check("bad paymentMethod → 400", r.status === 400);
  check("bad paymentMethod → NO deposit initiated", depositCount() === before);

  // ── 2. Bad contributionType ──
  before = depositCount();
  r = await post("/contributions", String(userId), {
    groupId: GROUP_ID, amount: 1, contributionType: "penalty",
    paymentMethod: "Airtel Money", payerPhone: TEST_PHONE,
  });
  await sleep(400);
  check("bad contributionType → 400", r.status === 400);
  check("bad contributionType → NO deposit initiated", depositCount() === before);

  // ── 3. Group creation with an invalid groupType ──
  before = depositCount();
  r = await post("/groups", String(userId), {
    name: `${TEST_NAME} Group`, groupType: "bogus-type", payerPhone: TEST_PHONE,
  });
  await sleep(400);
  check("bad groupType on create → 400", r.status === 400);
  check("bad groupType on create → NO fee deposit initiated", depositCount() === before);
  const strayGroup = await db.collection("groups").findOne({ name: `${TEST_NAME} Group` });
  check("bad groupType on create → no group document", !strayGroup);

  check("no transaction records from invalid requests",
    (await db.collection("transactions").countDocuments({ memberId: userId })) === 0);

  // ── 4. Valid Cash contribution still works (pending, no deposit) ──
  before = depositCount();
  r = await post("/contributions", String(userId), {
    groupId: GROUP_ID, amount: 1, contributionType: "topup", paymentMethod: "Cash",
  });
  await sleep(400);
  check("valid Cash contribution → 201 pending",
    r.status === 201 && r.body.transaction?.status === "pending");
  check("Cash contribution → NO deposit initiated", depositCount() === before);
  if (r.body.transaction?._id) txnIds.push(oid(r.body.transaction._id));

  // ── 5. Valid mobile-money contribution initiates exactly one deposit ──
  const groupBefore = await db.collection("groups").findOne({ _id: oid(GROUP_ID) },
    { projection: { totalSavings: 1, walletBalance: 1 } });
  before = depositCount();
  r = await post("/contributions", String(userId), {
    groupId: GROUP_ID, amount: 1, contributionType: "topup",
    paymentMethod: "Airtel Money", payerPhone: TEST_PHONE,
  });
  await sleep(400);
  check("valid mobile contribution → 201", r.status === 201);
  check("valid mobile contribution → exactly ONE deposit initiated",
    depositCount() === before + 1);
  const txn = r.body.transaction;
  check("transaction recorded with depositId (simulated → completed)",
    !!txn?.pawapay?.depositId && txn?.status === "completed");
  if (txn?._id) { txnIds.push(oid(txn._id)); mobileSettled = txn.status === "completed"; }

  const groupAfter = await db.collection("groups").findOne({ _id: oid(GROUP_ID) },
    { projection: { totalSavings: 1, walletBalance: 1, members: 1 } });
  const me = groupAfter.members.find((m) => String(m.userId) === String(userId));
  check("settlement applied (member savings +1, group rollups +1)",
    me?.savings === 1 &&
    groupAfter.totalSavings === groupBefore.totalSavings + 1 &&
    groupAfter.walletBalance === groupBefore.walletBalance + 1);
} finally {
  // Cleanup always runs, even if assertions or the network blew up above.
  if (mobileSettled)
    await db.collection("groups").updateOne(
      { _id: oid(GROUP_ID) }, { $inc: { totalSavings: -1, walletBalance: -1 } });
  await db.collection("groups").updateOne(
    { _id: oid(GROUP_ID) }, { $pull: { members: { userId } } });
  await db.collection("users").deleteOne({ _id: userId });
  await db.collection("transactions").deleteMany({ memberId: userId });
  if (txnIds.length)
    await db.collection("notifications").deleteMany({ transactionId: { $in: txnIds } });
  await db.collection("notifications").deleteMany({ body: new RegExp(TEST_NAME) });
  console.log("Cleanup done — synthetic user/member/txns/notifications removed, rollups reverted.");
  await mongoose.disconnect();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failed.length ? 1 : 0);
