// E2E verification of GROUP SEARCH + REQUEST TO JOIN.
// Builds a synthetic group (a Chairperson and an ordinary Member) and three
// outsiders, then drives the real flow: search shows the group with the
// caller's standing in it → an outsider asks to join (admins are notified, a
// second ask is a no-op) → an ordinary member cannot approve → an admin
// approves and the requester is an active member with nothing left to accept →
// an outsider who already holds an invite is pointed at it instead → a declined
// request is dropped and the requester told. No money moves. Cleans up after.
//
// Usage: npm run verify:join-requests   (backend must be running on :5000)
import "dotenv/config";
import dns from "dns";
// The local router's DNS intermittently SERVFAILs TXT/SRV lookups; bypass it.
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.promises.setServers(["8.8.8.8", "1.1.1.1"]);
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

const API = "http://localhost:5000";
const GROUP_NAME = "JOINREQ VERIFY (synthetic)";

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
const sign = (uid) => jwt.sign({ uid: String(uid) }, process.env.JWT_SECRET, { expiresIn: "1h" });
const headers = (uid) => ({ "Content-Type": "application/json", Authorization: `Bearer ${sign(uid)}` });
const call = async (method, path, uid) => {
  const res = await fetch(`${API}/api${path}`, { method, headers: headers(uid) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const results = [];
const check = (name, cond) => { results.push([name, cond]); console.log(`${cond ? "PASS" : "FAIL"}: ${name}`); };

// ── Seed ──
const now = new Date();
const people = {
  chair: { name: "JoinReq Chair (synthetic)", phone: "260970000101" },
  member: { name: "JoinReq Member (synthetic)", phone: "260970000102" },
  asker: { name: "JoinReq Asker (synthetic)", phone: "260970000103" },
  invitee: { name: "JoinReq Invitee (synthetic)", phone: "260970000104" },
  declined: { name: "JoinReq Declined (synthetic)", phone: "260970000105" },
};
const usersRes = await db.collection("users").insertMany(
  Object.values(people).map((p) => ({
    ...p, trustScore: 70, kyc: { status: "incomplete" }, joinedDate: now, createdAt: now, updatedAt: now,
  }))
);
const ids = Object.fromEntries(Object.keys(people).map((k, i) => [k, usersRes.insertedIds[i]]));
const row = (k, role, status = "active") => ({
  _id: new mongoose.Types.ObjectId(), userId: ids[k], name: people[k].name, phone: people[k].phone,
  role, status, savings: 0, contributions: 0, loanActive: 0,
});
const groupRes = await db.collection("groups").insertOne({
  name: GROUP_NAME,
  groupType: "savings-group",
  totalSavings: 0, walletBalance: 0, loanCirculation: 0,
  contributionAmount: 50, contributionFrequency: "Monthly",
  governance: { chairpersonUserId: ids.chair },
  members: [row("chair", "Chairperson"), row("member", "Member"), row("invitee", "Member", "pending")],
  joinRequests: [],
  status: "active", createdAt: now, updatedAt: now,
});
const groupId = groupRes.insertedId;
const gid = String(groupId);

try {
  const search = async (uid) =>
    (await call("GET", `/groups/search?q=${encodeURIComponent("joinreq verify")}`, uid)).body.groups?.find(
      (g) => g.id === gid
    );

  // ── Search ──
  const found = await search(ids.asker);
  check("search finds the group by part of its name, any case", !!found);
  check("an outsider's standing is 'none'", found?.relation === "none");
  check("chairperson name is shown to tell same-named groups apart",
    found?.chairpersonName === people.chair.name);
  check("balances and member list are not exposed",
    found && !("totalSavings" in found) && !("members" in found));
  check("a member sees 'member'", (await search(ids.member))?.relation === "member");
  check("an invitee sees 'invited'", (await search(ids.invitee))?.relation === "invited");
  check("a one-letter query returns nothing",
    (await call("GET", "/groups/search?q=j", ids.asker)).body.groups?.length === 0);

  // ── Request ──
  const ask = await call("POST", `/groups/${gid}/join-request`, ids.asker);
  check("outsider can ask to join (201)", ask.status === 201);
  check("the chairperson is notified",
    (await db.collection("notifications").countDocuments({ groupId, userId: ids.chair, type: "join_request" })) === 1);
  check("an ordinary member is not notified",
    (await db.collection("notifications").countDocuments({ groupId, userId: ids.member, type: "join_request" })) === 0);
  const again = await call("POST", `/groups/${gid}/join-request`, ids.asker);
  check("asking twice is a no-op", again.status === 200 && again.body.alreadyRequested === true);
  check("search now reads 'requested'", (await search(ids.asker))?.relation === "requested");

  const invited = await call("POST", `/groups/${gid}/join-request`, ids.invitee);
  check("someone already invited is pointed at the invite (409 already_invited)",
    invited.status === 409 && invited.body.code === "already_invited");
  const already = await call("POST", `/groups/${gid}/join-request`, ids.member);
  check("a member asking is told they are already in", already.body.alreadyMember === true);

  const g1 = await db.collection("groups").findOne({ _id: groupId });
  check("exactly one request is queued", g1.joinRequests.length === 1);
  const reqId = String(g1.joinRequests[0]._id);

  // ── Approve ──
  const byMember = await call("POST", `/groups/${gid}/join-requests/${reqId}/approve`, ids.member);
  check("an ordinary member cannot approve (403)", byMember.status === 403);
  const approve = await call("POST", `/groups/${gid}/join-requests/${reqId}/approve`, ids.chair);
  check("the chairperson can approve", approve.status === 200);
  const g2 = await db.collection("groups").findOne({ _id: groupId });
  const askerRow = g2.members.find((m) => String(m.userId) === String(ids.asker));
  check("the requester is an ACTIVE Member - nothing left for them to accept",
    askerRow?.status === "active" && askerRow?.role === "Member");
  check("the request is gone", g2.joinRequests.length === 0);
  check("the requester is told",
    (await db.collection("notifications").countDocuments({ groupId, userId: ids.asker, title: "Request approved" })) === 1);
  check("search now reads 'member'", (await search(ids.asker))?.relation === "member");
  const twice = await call("POST", `/groups/${gid}/join-requests/${reqId}/approve`, ids.chair);
  check("approving the same request again is refused (404)", twice.status === 404);

  // ── Decline ──
  await call("POST", `/groups/${gid}/join-request`, ids.declined);
  const g3 = await db.collection("groups").findOne({ _id: groupId });
  const declineId = String(g3.joinRequests[0]._id);
  const decline = await call("POST", `/groups/${gid}/join-requests/${declineId}/decline`, ids.chair);
  check("the chairperson can decline", decline.status === 200);
  const g4 = await db.collection("groups").findOne({ _id: groupId });
  check("a declined request is dropped and adds no member",
    g4.joinRequests.length === 0 &&
      !g4.members.some((m) => String(m.userId) === String(ids.declined)));
  check("the declined requester is told",
    (await db.collection("notifications").countDocuments({ groupId, userId: ids.declined, title: "Request declined" })) === 1);

  // ── Withdraw ──
  await call("POST", `/groups/${gid}/join-request`, ids.declined);
  const withdraw = await call("DELETE", `/groups/${gid}/join-request`, ids.declined);
  const g5 = await db.collection("groups").findOne({ _id: groupId });
  check("a requester can withdraw their own request",
    withdraw.status === 200 && g5.joinRequests.length === 0);
} finally {
  // Cleanup always runs, even if assertions or the network blew up above.
  await db.collection("notifications").deleteMany({ groupId });
  await db.collection("groups").deleteOne({ _id: groupId });
  await db.collection("users").deleteMany({ _id: { $in: Object.values(ids) } });
  console.log("Cleanup done - synthetic group/users/notifications removed.");
  await mongoose.disconnect();
}

const failed = results.filter(([, ok]) => !ok);
console.log(failed.length ? `\n${failed.length} FAILURE(S)` : "\nALL CHECKS PASSED");
process.exit(failed.length ? 1 : 0);
