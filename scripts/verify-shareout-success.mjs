// E2E verification of share-out SUCCESS settlement effects.
// Builds a synthetic group (Gilbert as Chairperson + two synthetic members
// whose phones are PawaPay sandbox always-COMPLETE payout numbers), then
// drives the real flow: propose share-out → admin approve (executes
// distributeShareOut) → two real PawaPay payouts → COMPLETED callbacks.
// Asserts each member's stake is retired as their payout settles, the wallet
// is drawn down by the shares paid, and the cycle closes (totalSavings 0,
// cycleProgress 0) when the last payout lands. Cleans up everything.
// Total real money movement: K5 in sandbox.
//
// Usage: npm run verify:shareout   (backend must be running on :5000)
import "dotenv/config";
import dns from "dns";
// The local router's DNS intermittently SERVFAILs TXT/SRV lookups; bypass it.
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.promises.setServers(["8.8.8.8", "1.1.1.1"]);
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

const ADMIN_ID = "6a47cb8be9d07482567dfcc0"; // Gilbert
const API = "http://localhost:5000";
// Sandbox numbers whose PAYOUTS always COMPLETE (see docs.pawapay.io test numbers)
const MEMBER_A = { name: "Shareout A (synthetic)", phone: "260973456789", savings: 3 }; // Airtel
const MEMBER_B = { name: "Shareout B (synthetic)", phone: "260763456789", savings: 2 }; // MTN
const POT = MEMBER_A.savings + MEMBER_B.savings;

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

// ── Seed: two synthetic users + a synthetic group with Gilbert as admin ──
const now = new Date();
const usersRes = await db.collection("users").insertMany([
  { name: MEMBER_A.name, phone: MEMBER_A.phone, trustScore: 70, kyc: { status: "incomplete" }, joinedDate: now, createdAt: now, updatedAt: now },
  { name: MEMBER_B.name, phone: MEMBER_B.phone, trustScore: 70, kyc: { status: "incomplete" }, joinedDate: now, createdAt: now, updatedAt: now },
]);
const [idA, idB] = [usersRes.insertedIds[0], usersRes.insertedIds[1]];
const groupRes = await db.collection("groups").insertOne({
  name: "SHAREOUT VERIFY (synthetic)",
  groupType: "savings-group",
  totalSavings: POT, walletBalance: POT, loanCirculation: 0,
  contributionAmount: 1, contributionFrequency: "Monthly",
  cycleProgress: 0.5,
  loanInterestRate: 0, loanMaxMultiplier: 3,
  constitution: {
    gracePeriodDays: 2, loanMultiplier: 3, loanInterestRate: 0,
    loanRepaymentMonths: 12, internalLendingEnabled: true,
    approvalThreshold: "majority", penaltyFundsDestination: "group-pool",
    penaltyRules: { lateContribution: {}, missingMeeting: {}, lateRepayment: {} },
  },
  members: [
    { userId: oid(ADMIN_ID), name: "Gilbert", role: "Chairperson", status: "active", savings: 0, contributions: 0, loanActive: 0 },
    { userId: idA, name: MEMBER_A.name, phone: MEMBER_A.phone, role: "Member", status: "active", savings: MEMBER_A.savings, contributions: 1, loanActive: 0 },
    { userId: idB, name: MEMBER_B.name, phone: MEMBER_B.phone, role: "Member", status: "active", savings: MEMBER_B.savings, contributions: 1, loanActive: 0 },
  ],
  status: "active", createdAt: now, updatedAt: now,
});
const groupId = groupRes.insertedId;
console.log(`Seeded group ${groupId} (pot K${POT}) + members ${idA}, ${idB}`);

let approvalId = null;
try {
  // ── Propose share-out as Gilbert ──
  const propRes = await fetch(`${API}/api/shareout/${groupId}/propose`, {
    method: "POST", headers: headers(ADMIN_ID), body: JSON.stringify({}),
  });
  const propBody = await propRes.json();
  approvalId = propBody.approval?._id;
  check("share-out proposed", propRes.status === 201 && !!approvalId);

  // ── Approve (sole admin → executes distributeShareOut inline) ──
  let executed = null;
  if (approvalId) {
    const voteRes = await fetch(`${API}/api/approvals/${approvalId}/vote`, {
      method: "POST", headers: headers(ADMIN_ID),
      body: JSON.stringify({ decision: "approve" }),
    });
    const voteBody = await voteRes.json();
    executed = voteBody.executed;
    console.log(`vote: ${voteRes.status} executed=${JSON.stringify(executed).slice(0, 200)}`);
  }
  check("share-out distributed two real payouts",
    executed?.type === "share-out-distributed" && executed?.payouts?.length === 2);

  // ── Wait for both payouts to settle (callback; cron as backstop) ──
  let txns = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 8.5 * 60 * 1000) {
    txns = await db.collection("transactions").find({ groupId, type: "share-out" }).toArray();
    if (txns.length === 2 && txns.every((t) => t.status !== "pending")) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`share-out payouts settled after ${Math.round((Date.now() - t0) / 1000)}s: ` +
    txns.map((t) => `${t.memberName}→${t.status}`).join(", "));

  check("both payouts COMPLETED",
    txns.length === 2 && txns.every((t) => t.status === "completed" && t.pawapay?.status === "COMPLETED"));

  // Settlement effects are applied after the txn flip (webhook responds before
  // they're durable) — poll briefly for the final group state.
  let g = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 60 * 1000) {
    g = await db.collection("groups").findOne({ _id: groupId });
    if (g.totalSavings === 0 && g.cycleProgress === 0 && g.walletBalance === 0) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log(`group state settled after ${Math.round((Date.now() - t1) / 1000)}s`);
  const mA = g.members.find((m) => String(m.userId) === String(idA));
  const mB = g.members.find((m) => String(m.userId) === String(idB));
  check("each member's stake retired (savings 0, contributions 0)",
    mA.savings === 0 && mA.contributions === 0 && mB.savings === 0 && mB.contributions === 0);
  check("wallet drawn down by shares paid (walletBalance 0)", g.walletBalance === 0);
  check("cycle closed when last payout settled (totalSavings 0, cycleProgress 0)",
    g.totalSavings === 0 && g.cycleProgress === 0);

  const approval = await db.collection("approvals").findOne({ _id: oid(approvalId) });
  check("approval consumed (status executed — cannot distribute twice)",
    approval?.status === "executed");
} finally {
  // Cleanup always runs, even if assertions or the network blew up above.
  await db.collection("transactions").deleteMany({ groupId });
  await db.collection("notifications").deleteMany({ groupId });
  await db.collection("approvals").deleteMany({ groupId });
  await db.collection("groups").deleteOne({ _id: groupId });
  await db.collection("users").deleteMany({ _id: { $in: [idA, idB] } });
  console.log("Cleanup done — synthetic group/users/txns/approvals/notifications removed.");
  await mongoose.disconnect();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failed.length ? 1 : 0);
