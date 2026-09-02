// E2E verification of MEMBER REMOVAL: proposal → other admins vote → refund.
// Builds a synthetic group (Gilbert as Chairperson, a synthetic Treasurer, and
// a synthetic ordinary member holding a K2 stake), then drives the real flow:
// an admin cannot be proposed for removal at all → the ordinary member is
// proposed → they get no vote on it → both admins approve → a real PawaPay
// payout refunds their stake → the COMPLETED callback retires their row.
// Asserts the refund lands, the row only flips to "removed" once it does, and
// that removal ERASES NOTHING: the contribution count, the figures as they
// stood at the exit and every transaction they made survive. Cleans up after.
// Total real money movement: K2 in sandbox.
//
// Usage: npm run verify:member-removal   (backend must be running on :5000)
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
const TREASURER = { name: "Removal T (synthetic)", phone: "260973456788" };
const TARGET = { name: "Removal X (synthetic)", phone: "260973456789", savings: 2 };

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

// ── Seed: a synthetic Treasurer + the member to remove, and their group ──
const now = new Date();
const usersRes = await db.collection("users").insertMany([
  { name: TREASURER.name, phone: TREASURER.phone, trustScore: 70, kyc: { status: "incomplete" }, joinedDate: now, createdAt: now, updatedAt: now },
  { name: TARGET.name, phone: TARGET.phone, trustScore: 70, kyc: { status: "incomplete" }, joinedDate: now, createdAt: now, updatedAt: now },
]);
const [idT, idX] = [usersRes.insertedIds[0], usersRes.insertedIds[1]];
// Member row ids are what the remove endpoint addresses, so mint them here.
const rowT = new mongoose.Types.ObjectId();
const rowX = new mongoose.Types.ObjectId();
const groupRes = await db.collection("groups").insertOne({
  name: "REMOVAL VERIFY (synthetic)",
  groupType: "savings-group",
  totalSavings: TARGET.savings, walletBalance: TARGET.savings, loanCirculation: 0,
  contributionAmount: 1, contributionFrequency: "Monthly",
  cycleProgress: 0.5,
  loanInterestRate: 0, loanMaxMultiplier: 3,
  constitution: {
    gracePeriodDays: 2, loanMultiplier: 3, loanInterestRate: 0,
    loanRepaymentMonths: 12, internalLendingEnabled: true,
    approvalThreshold: "majority", penaltyFundsDestination: "group-pool",
    penaltyRules: { lateContribution: {}, missingMeeting: {}, lateRepayment: {} },
  },
  governance: { chairpersonUserId: oid(ADMIN_ID) },
  members: [
    { _id: new mongoose.Types.ObjectId(), userId: oid(ADMIN_ID), name: "Gilbert", role: "Chairperson", status: "active", savings: 0, contributions: 0, loanActive: 0 },
    { _id: rowT, userId: idT, name: TREASURER.name, phone: TREASURER.phone, role: "Treasurer", status: "active", savings: 0, contributions: 0, loanActive: 0 },
    { _id: rowX, userId: idX, name: TARGET.name, phone: TARGET.phone, role: "Member", status: "active", savings: TARGET.savings, contributions: 3, loanActive: 0 },
  ],
  status: "active", createdAt: now, updatedAt: now,
});
const groupId = groupRes.insertedId;
// A past contribution of theirs: removal must not touch the ledger.
await db.collection("transactions").insertOne({
  groupId, groupName: "REMOVAL VERIFY (synthetic)",
  memberId: idX, memberName: TARGET.name,
  type: "contribution", amount: 1, status: "completed",
  note: "Seeded history", receiptId: "CHM-VERIFY-HIST",
  date: now, createdAt: now, updatedAt: now,
});
console.log(`Seeded group ${groupId} — removing ${TARGET.name} (row ${rowX}, K${TARGET.savings} saved)`);

let approvalId = null;
try {
  // ── An admin cannot be proposed for removal at all ──
  const adminRes = await fetch(`${API}/api/groups/${groupId}/members/${rowT}/remove`, {
    method: "POST", headers: headers(ADMIN_ID), body: JSON.stringify({}),
  });
  const adminBody = await adminRes.json();
  check("admin cannot be removed",
    adminRes.status === 400 && /admin cannot be removed/i.test(adminBody.error || ""));

  // ── Propose removing the ordinary member, as Gilbert ──
  const propRes = await fetch(`${API}/api/groups/${groupId}/members/${rowX}/remove`, {
    method: "POST", headers: headers(ADMIN_ID),
    body: JSON.stringify({ reason: "verification run" }),
  });
  const prop = await propRes.json();
  approvalId = prop.approval?._id;
  check("removal proposed", propRes.status === 200 && !!approvalId);
  // Voters are the admins — Gilbert + the Treasurer. Majority of 2 = 2.
  check("quorum is the group's admins", prop.eligibleVoters === 2 && prop.requiredApprovals === 2);
  check("refund quoted as their full stake", prop.refund === TARGET.savings);

  // ── A second proposal for the same member is refused ──
  const dupRes = await fetch(`${API}/api/groups/${groupId}/members/${rowX}/remove`, {
    method: "POST", headers: headers(ADMIN_ID), body: JSON.stringify({}),
  });
  check("duplicate proposal refused while one is pending", dupRes.status === 409);

  // ── The member being removed has no vote on it ──
  const selfRes = await fetch(`${API}/api/approvals/${approvalId}/vote`, {
    method: "POST", headers: headers(String(idX)),
    body: JSON.stringify({ decision: "reject" }),
  });
  check("target gets no vote on their own removal", selfRes.status === 403);

  // ── First approval: quorum not met, nobody removed yet ──
  const vote1 = await fetch(`${API}/api/approvals/${approvalId}/vote`, {
    method: "POST", headers: headers(ADMIN_ID),
    body: JSON.stringify({ decision: "approve" }),
  });
  const v1 = await vote1.json();
  check("first approval does not remove anyone",
    vote1.status === 200 && v1.approval?.status === "pending" && !v1.executed);

  // ── Second approval carries it and pays the refund out ──
  const vote2 = await fetch(`${API}/api/approvals/${approvalId}/vote`, {
    method: "POST", headers: headers(String(idT)),
    body: JSON.stringify({ decision: "approve" }),
  });
  const v2 = await vote2.json();
  console.log(`vote 2: ${vote2.status} executed=${JSON.stringify(v2.executed).slice(0, 200)}`);
  check("second approval executes the removal", v2.executed?.type === "member-removed");
  check("refund payout initiated for their stake", v2.executed?.refunded > 0);

  // ── Still a member until the money actually lands ──
  const midway = await db.collection("groups").findOne({ _id: groupId });
  const rowMid = midway.members.find((m) => String(m._id) === String(rowX));
  const settledInline = v2.executed?.removed === true;
  check("row retires only when the payout settles, never at approval time",
    settledInline || rowMid.status === "active");

  // ── Wait for the payout to settle (callback; cron as backstop) ──
  let txn = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 8.5 * 60 * 1000) {
    txn = await db.collection("transactions").findOne({ groupId, type: "withdrawal" });
    if (txn && txn.status !== "pending") break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`refund settled after ${Math.round((Date.now() - t0) / 1000)}s: ${txn?.status}`);
  check("refund payout COMPLETED",
    txn?.status === "completed" && txn?.pawapay?.status === "COMPLETED");

  // Settlement effects land just after the txn flips — poll for final state.
  let g = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 60 * 1000) {
    g = await db.collection("groups").findOne({ _id: groupId });
    if (g.members.find((m) => String(m._id) === String(rowX))?.status === "removed") break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const rowFinal = g.members.find((m) => String(m._id) === String(rowX));
  check("member row retired once the refund landed",
    rowFinal?.status === "removed" && rowFinal?.savings === 0);
  check("their stake left the pool", g.totalSavings === 0 && g.walletBalance === 0);

  // ── Removal ends a membership; it does not erase a history ──
  check("member row KEPT, not deleted", !!rowFinal);
  check("contribution count survives removal", rowFinal?.contributions === 3);
  check("figures at exit frozen on the record",
    rowFinal?.exitSavings === TARGET.savings &&
    rowFinal?.exitRefund > 0 &&
    !!rowFinal?.exitedAt);
  const history = await db.collection("transactions").countDocuments({
    groupId, memberId: idX, type: "contribution",
  });
  check("their transactions stay in the group ledger", history === 1);

  const approval = await db.collection("approvals").findOne({ _id: oid(approvalId) });
  check("approval consumed (status executed — cannot refund twice)",
    approval?.status === "executed");

  // ── An already-removed member cannot be proposed again ──
  const againRes = await fetch(`${API}/api/groups/${groupId}/members/${rowX}/remove`, {
    method: "POST", headers: headers(ADMIN_ID), body: JSON.stringify({}),
  });
  check("removed member cannot be removed again", againRes.status === 400);
} finally {
  // Cleanup always runs, even if assertions or the network blew up above.
  await db.collection("transactions").deleteMany({ groupId });
  await db.collection("notifications").deleteMany({ groupId });
  await db.collection("approvals").deleteMany({ groupId });
  await db.collection("platformrevenues").deleteMany({ groupId });
  await db.collection("groups").deleteOne({ _id: groupId });
  await db.collection("users").deleteMany({ _id: { $in: [idT, idX] } });
  console.log("Cleanup done — synthetic group/users/txns/approvals/notifications removed.");
  await mongoose.disconnect();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failed.length ? 1 : 0);
