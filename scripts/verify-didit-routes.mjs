/**
 * Route-level smoke test for the Didit KYC endpoints — the REAL handlers.
 *
 *   npm run verify:didit-routes
 *
 * Mounts the actual auth + webhook routers on an ephemeral port (no clash with a
 * dev server on :5000, no cron) and drives the production request path over HTTP
 * against the dev DB. It creates throwaway users and DELETES them at the end.
 *
 * Modes exercised (all WITHOUT a Didit account):
 *   - Simulated /kyc/session + /kyc/status  (DIDIT_ENABLED=false auto-approve)
 *   - Webhook /api/webhooks/didit with signature verification ON:
 *       · bad signature            → 401
 *       · valid sig, unknown user  → 200 no-op
 *       · valid sig, approved      → user verified + display name set
 *       · valid sig, late decline  → already-verified user NOT downgraded
 *
 * Env is set below BEFORE importing config so we get sim /kyc routes AND live
 * webhook signature checks in one run.
 */

import "dotenv/config";
import dns from "dns";
// The local router occasionally SERVFAILs Atlas SRV/TXT lookups; bypass it.
dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.promises.setServers(["8.8.8.8", "1.1.1.1"]);

// Sim mode for /kyc/* routes, but force webhook signature verification ON.
process.env.DIDIT_ENABLED = "false";
process.env.DIDIT_VERIFY_WEBHOOKS = "true";
process.env.DIDIT_WEBHOOK_SECRET = "whsec_route_test";

import crypto from "crypto";
import express from "express";
import mongoose from "mongoose";

const { config } = await import("../src/config/index.js");
const { User } = await import("../src/models/User.js");
const { signToken } = await import("../src/middleware/auth.js");
const authRoutes = (await import("../src/routes/auth.routes.js")).default;
const webhookRoutes = (await import("../src/routes/webhook.routes.js")).default;

// ── tiny assert helpers ──────────────────────────────────────────────────────
let passed = 0;
let total = 0;
const failures = [];
function check(label, condition) {
  total++;
  if (condition) passed++;
  else {
    failures.push(label);
    console.log(`   ✗ ${label}`);
  }
}

// ── Build an app with the SAME rawBody json middleware as server.js ──────────
const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use("/api/auth", authRoutes);
app.use("/api/webhooks", webhookRoutes);

// ── Connect DB (Atlas intermittently TLS-alerts; retry) + start server ───────
let connected = false;
for (let i = 1; i <= 5 && !connected; i++) {
  try {
    await mongoose.connect(config.mongoUri, { dbName: "chuma", serverSelectionTimeoutMS: 30000 });
    connected = true;
  } catch (e) {
    console.log(`mongo connect attempt ${i} failed: ${e.message} — retrying in 5s`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
if (!connected) {
  console.error("Could not reach Atlas — network problem. Re-run later.");
  process.exit(2);
}
const server = await new Promise((resolve) => {
  const s = app.listen(0, "127.0.0.1", () => resolve(s));
});
const { port } = server.address();
const BASE = `http://127.0.0.1:${port}`;

const created = [];
async function makeUser(name) {
  const u = await User.create({
    name,
    phone: `+260${Math.floor(700000000 + Math.random() * 99999999)}`,
    kyc: { status: "incomplete" },
  });
  created.push(u._id);
  return u;
}
const authHeaders = (u) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${signToken(u._id)}`,
});
function sign(bodyStr) {
  return crypto
    .createHmac("sha256", process.env.DIDIT_WEBHOOK_SECRET)
    .update(Buffer.from(bodyStr))
    .digest("hex");
}

try {
  // ── 1. SIMULATED /kyc/session ──────────────────────────────────────────────
  const simUser = await makeUser("Grace Mwangi");
  let r = await fetch(`${BASE}/api/auth/kyc/session`, {
    method: "POST",
    headers: authHeaders(simUser),
    body: JSON.stringify({ returnUrl: "chuma://kyc-return" }),
  });
  let j = await r.json();
  check("sim session: 200", r.status === 200);
  check("sim session: sim_ sessionId", typeof j.sessionId === "string" && j.sessionId.startsWith("sim_"));
  check("sim session: returns a url", typeof j.url === "string" && j.url.length > 0);

  const afterSession = await User.findById(simUser._id);
  check("sim session: kyc pending persisted", afterSession.kyc.status === "pending");
  check("sim session: provider didit-sim", afterSession.kyc.provider === "didit-sim");

  // ── 2. SIMULATED /kyc/status → auto-approve ────────────────────────────────
  r = await fetch(`${BASE}/api/auth/kyc/status`, { headers: authHeaders(simUser) });
  j = await r.json();
  check("sim status: 200", r.status === 200);
  check("sim status: approved", j.status === "approved");
  check("sim status: verified first name", j.verified?.firstName === "Grace");

  const afterStatus = await User.findById(simUser._id);
  check("sim status: user marked verified", afterStatus.kyc.status === "verified");
  // Sim mode deliberately KEEPS the user's existing display name (only the live
  // path overwrites user.name); it records the derived first name in kyc.
  check("sim status: existing display name kept", afterStatus.name === "Grace Mwangi");
  check("sim status: kyc.firstName derived", afterStatus.kyc.firstName === "Grace");

  // ── 3. WEBHOOK: bad signature → 401 ────────────────────────────────────────
  const hookUser = await makeUser("placeholder");
  // Inline the v3 identity so the handler doesn't need to fetch the decision
  // (there's no real Didit to call in this offline route test).
  const approvedBody = JSON.stringify({
    session_id: "sess_hook_1",
    vendor_data: String(hookUser._id),
    status: "Approved",
    decision: { id_verifications: [{ first_name: "Daniel", last_name: "Phiri" }] },
  });
  r = await fetch(`${BASE}/api/webhooks/didit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-signature": "deadbeef" },
    body: approvedBody,
  });
  check("webhook bad sig: 401", r.status === 401);
  const stillPlaceholder = await User.findById(hookUser._id);
  check("webhook bad sig: user untouched", stillPlaceholder.kyc.status === "incomplete");

  // ── 4. WEBHOOK: valid sig, unknown user → 200 no-op ────────────────────────
  const unknownBody = JSON.stringify({
    session_id: "sess_unknown",
    vendor_data: new mongoose.Types.ObjectId().toString(),
    status: "Approved",
    decision: { id_verification: { first_name: "Nobody" } },
  });
  r = await fetch(`${BASE}/api/webhooks/didit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-signature": sign(unknownBody) },
    body: unknownBody,
  });
  check("webhook unknown user: 200 no-op", r.status === 200);

  // ── 5. WEBHOOK: valid sig, approved → verified + display name ──────────────
  r = await fetch(`${BASE}/api/webhooks/didit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-signature": sign(approvedBody) },
    body: approvedBody,
  });
  check("webhook approved: 200", r.status === 200);
  const verified = await User.findById(hookUser._id);
  check("webhook approved: user verified", verified.kyc.status === "verified");
  check("webhook approved: display name set", verified.name === "Daniel");
  check("webhook approved: fullName captured", verified.kyc.fullName === "Daniel Phiri");

  // ── 6. WEBHOOK: late decline must NOT downgrade a verified user ─────────────
  const declineBody = JSON.stringify({
    session_id: "sess_hook_1",
    vendor_data: String(hookUser._id),
    status: "Declined",
  });
  r = await fetch(`${BASE}/api/webhooks/didit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-signature": sign(declineBody) },
    body: declineBody,
  });
  check("webhook late decline: 200", r.status === 200);
  const afterDecline = await User.findById(hookUser._id);
  check("webhook late decline: stays verified (no downgrade)", afterDecline.kyc.status === "verified");
} finally {
  // ── Cleanup: remove every throwaway user we created ────────────────────────
  if (created.length) await User.deleteMany({ _id: { $in: created } });
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
}

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log("");
if (failures.length === 0) {
  console.log(`PASS (${passed}/${total})`);
  process.exit(0);
} else {
  console.log(`FAIL (${passed}/${total}) — ${failures.length} failed`);
  process.exit(1);
}
