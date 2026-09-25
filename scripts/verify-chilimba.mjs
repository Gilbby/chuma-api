// E2E verification of the chilimba (rotating savings) round-payout flow.
// Builds a synthetic chilimba group (Gilbert as Chairperson + two synthetic
// members), then drives the real flow round by round:
//   draw order → for each round: simulate the round's contributions into the
//   pool → propose payout → admin approve (executes the chilimba-payout inline
//   as recorded cash) → assert the pool went to exactly the member whose turn it
//   was, the pool emptied, and the rotation advanced.
// Finally asserts every member received exactly once and the rotation completed.
// No real money moves: chilimba payouts are recorded cash, settled inline.
//
// Usage: npm run verify:chilimba   (backend must be running on :5000)
import "dotenv/config";
import dns from "dns";
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.promises.setServers(["8.8.8.8", "1.1.1.1"]);
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

const ADMIN_ID = "6a47cb8be9d07482567dfcc0"; // Gilbert (Chairperson)
const API = "http://localhost:5000";
const CONTRIB = 1; // per member each round
const MEMBER_A = { name: "Chilimba A (synthetic)", phone: "260973456700" };
const MEMBER_B = { name: "Chilimba B (synthetic)", phone: "260763456700" };

let connected = false;
for (let i = 1; i <= 5 && !connected; i++) {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 30000 });
    connected = true;
  } catch (e) {
    console.log(`mongo connect attempt ${i} failed: ${e.message} - retrying in 10s`);
    await new Promise((r) => setTimeout(r, 10000));
  }
}
if (!connected) {
  console.error("Could not reach Atlas - network problem. Re-run later.");
  process.exit(2);
}
const db = mongoose.connection.db;
const oid = (s) => new mongoose.Types.ObjectId(s);
const sign = (uid) => jwt.sign({ uid }, process.env.JWT_SECRET, { expiresIn: "1h" });
const headers = (uid) => ({ "Content-Type": "application/json", Authorization: `Bearer ${sign(uid)}` });

const results = [];
const check = (name, cond) => { results.push([name, cond]); console.log(`${cond ? "PASS" : "FAIL"}: ${name}`); };

const now = new Date();
const usersRes = await db.collection("users").insertMany([
  { name: MEMBER_A.name, phone: MEMBER_A.phone, trustScore: 70, kyc: { status: "incomplete" }, joinedDate: now, createdAt: now, updatedAt: now },
  { name: MEMBER_B.name, phone: MEMBER_B.phone, trustScore: 70, kyc: { status: "incomplete" }, joinedDate: now, createdAt: now, updatedAt: now },
]);
const [idA, idB] = [usersRes.insertedIds[0], usersRes.insertedIds[1]];
const memberIds = [ADMIN_ID, String(idA), String(idB)];
const POOL = CONTRIB * memberIds.length;

const groupRes = await db.collection("groups").insertOne({
  name: "CHILIMBA VERIFY (synthetic)",
  groupType: "chilimba",
  totalSavings: 0, walletBalance: 0, loanCirculation: 0,
  contributionAmount: CONTRIB, contributionFrequency: "Monthly",
  cycleProgress: 0,
  loanInterestRate: 0, loanMaxMultiplier: 0,
  constitution: {
    gracePeriodDays: 2, internalLendingEnabled: false,
    approvalThreshold: "majority", penaltyFundsDestination: "group-pool",
    penaltyRules: { lateContribution: {}, missingMeeting: {}, lateRepayment: {} },
  },
  chilimba: { orderDrawn: false, currentRound: 0 },
  members: [
    { userId: oid(ADMIN_ID), name: "Gilbert", role: "Chairperson", status: "active", savings: 0, contributions: 0, loanActive: 0 },
    { userId: idA, name: MEMBER_A.name, phone: MEMBER_A.phone, role: "Member", status: "active", savings: 0, contributions: 0, loanActive: 0 },
    { userId: idB, name: MEMBER_B.name, phone: MEMBER_B.phone, role: "Member", status: "active", savings: 0, contributions: 0, loanActive: 0 },
  ],
  status: "active", createdAt: now, updatedAt: now,
});
const groupId = groupRes.insertedId;
console.log(`Seeded chilimba group ${groupId} (${memberIds.length} members, pool K${POOL}) + members ${idA}, ${idB}`);

// Put this round's contributions into the pool, exactly as settled contributions
// would (each active member's savings + the group rollups).
async function fillPool() {
  await db.collection("groups").updateOne(
    { _id: groupId },
    {
      $set: {
        walletBalance: POOL, totalSavings: POOL,
        "members.$[m].savings": CONTRIB,
      },
    },
    { arrayFilters: [{ "m.status": "active" }] }
  );
}

try {
  // ── Draw the order (Gilbert) ──
  const drawRes = await fetch(`${API}/api/chilimba/${groupId}/draw`, {
    method: "POST", headers: headers(ADMIN_ID),
  });
  const drawBody = await drawRes.json();
  check("order drawn", drawRes.status === 201 && drawBody.rotation?.orderDrawn === true);

  let g = await db.collection("groups").findOne({ _id: groupId });
  const positions = g.members.map((m) => m.payoutPosition).sort();
  check("positions assigned 1..N uniquely",
    JSON.stringify(positions) === JSON.stringify([1, 2, 3]));
  check("currentRound opened at 1 and totalRounds set",
    g.chilimba?.currentRound === 1 && g.chilimba?.totalRounds === 3);

  // ── Second draw is refused ──
  const draw2 = await fetch(`${API}/api/chilimba/${groupId}/draw`, {
    method: "POST", headers: headers(ADMIN_ID),
  });
  check("second draw refused (order already set)", draw2.status === 400);

  const received = [];
  for (let round = 1; round <= 3; round++) {
    await fillPool();

    // Who should receive this round, from the drawn order.
    g = await db.collection("groups").findOne({ _id: groupId });
    const due = g.members.find((m) => m.payoutPosition === round);

    // Propose (Gilbert) → approve (sole admin → executes inline).
    const prop = await fetch(`${API}/api/chilimba/${groupId}/propose-payout`, {
      method: "POST", headers: headers(ADMIN_ID),
    });
    const propBody = await prop.json();
    const approvalId = propBody.approval?._id;
    check(`round ${round}: payout proposed`, prop.status === 201 && !!approvalId);

    let executed = null;
    if (approvalId) {
      const vote = await fetch(`${API}/api/approvals/${approvalId}/vote`, {
        method: "POST", headers: headers(ADMIN_ID),
        body: JSON.stringify({ decision: "approve" }),
      });
      const voteBody = await vote.json();
      executed = voteBody.executed;
    }
    check(`round ${round}: whole pool paid to the member due this round`,
      executed?.type === "chilimba-payout-distributed" &&
      executed?.amount === POOL &&
      String(executed?.recipientId) === String(due.userId));

    g = await db.collection("groups").findOne({ _id: groupId });
    const paid = g.members.find((m) => String(m.userId) === String(due.userId));
    check(`round ${round}: recipient stamped received in this round`,
      paid.payoutReceived === true && paid.payoutRound === round);
    check(`round ${round}: pool emptied and rotation advanced`,
      g.walletBalance === 0 && g.totalSavings === 0 && g.chilimba.currentRound === round + 1);

    received.push(String(due.userId));
  }

  check("every member received exactly once",
    new Set(received).size === 3 && received.length === 3);
  g = await db.collection("groups").findOne({ _id: groupId });
  check("rotation complete after the last round",
    g.chilimba.currentRound > g.chilimba.totalRounds);

  // A payout proposed past the end is refused.
  await fillPool();
  const past = await fetch(`${API}/api/chilimba/${groupId}/propose-payout`, {
    method: "POST", headers: headers(ADMIN_ID),
  });
  check("payout after completion refused", past.status === 400);

  const payoutTxns = await db.collection("transactions")
    .find({ groupId, type: "chilimba-payout" }).toArray();
  check("one recorded payout per round",
    payoutTxns.length === 3 && payoutTxns.every((t) => t.status === "completed" && t.amount === POOL));
} finally {
  await db.collection("transactions").deleteMany({ groupId });
  await db.collection("notifications").deleteMany({ groupId });
  await db.collection("approvals").deleteMany({ groupId });
  await db.collection("groups").deleteOne({ _id: groupId });
  await db.collection("users").deleteMany({ _id: { $in: [idA, idB] } });
  console.log("Cleanup done - synthetic group/users/txns/approvals/notifications removed.");
  await mongoose.disconnect();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failed.length ? 1 : 0);
