/**
 * Standalone PASS/FAIL harness for the Didit KYC service LOGIC.
 *
 *   npm run verify:didit
 *
 * Offline & self-contained: no DB, no network, no real Didit account. It pins
 * down every pure decision the live KYC path depends on so we can be confident
 * before flipping DIDIT_ENABLED=true:
 *   - status vocabulary mapping (Didit strings → app KycStatus → User enum)
 *   - identity extraction across Didit's field-name variants
 *   - summarizeDecision (the shape /kyc/status and the webhook both consume)
 *   - HMAC-SHA256 webhook signature verify (real round-trip + tamper cases)
 *   - applyVerifiedIdentity against a fake user (name derivation + idempotency)
 *   - the webhook's "don't downgrade an already-verified user" rule
 *
 * It imports the service directly — same purity contract as the module.
 */

import crypto from "crypto";
import {
  normalizeStatus,
  modelStatusFor,
  extractIdentity,
  summarizeDecision,
  applyVerifiedIdentity,
  verifyWebhookSignature,
} from "../src/services/didit.service.js";

// ── tiny assert helpers ──────────────────────────────────────────────────────
let passed = 0;
let total = 0;
const failures = [];

function check(label, condition) {
  total++;
  if (condition) {
    passed++;
  } else {
    failures.push(label);
    console.log(`   ✗ ${label}`);
  }
}

// ── 1. Status vocabulary: Didit decision strings → app KycStatus ─────────────
const statusCases = [
  ["Approved", "approved"],
  ["approved", "approved"],
  ["  DECLINED ", "declined"],
  ["In Review", "in_review"],
  ["In Progress", "pending"],
  ["Not Started", "not_started"],
  ["Abandoned", "abandoned"],
  ["Expired", "expired"],
  ["KYC Expired", "expired"],
  ["something weird", "pending"], // unknown → pending
  [undefined, "pending"], // missing → pending
];
for (const [raw, want] of statusCases) {
  check(`normalizeStatus(${JSON.stringify(raw)})===${want}`, normalizeStatus(raw) === want);
}

// ── 2. App KycStatus → User.kyc.status model enum ────────────────────────────
const modelCases = [
  ["approved", "verified"],
  ["declined", "rejected"],
  ["expired", "incomplete"],
  ["abandoned", "incomplete"],
  ["in_review", "pending"],
  ["not_started", "pending"],
  ["pending", "pending"],
];
for (const [status, want] of modelCases) {
  check(`modelStatusFor(${status})===${want}`, modelStatusFor(status) === want);
}

// ── 3. extractIdentity across Didit field-name variants ──────────────────────
// v3 shape: identity nested in the id_verifications ARRAY (first entry).
const idV3 = extractIdentity({
  status: "Approved",
  id_verifications: [
    { first_name: "Mary", last_name: "Zulu", date_of_birth: "1988-05-02" },
  ],
});
check("extract v3 id_verifications[0] firstName", idV3.firstName === "Mary");
check("extract v3 id_verifications[0] lastName", idV3.lastName === "Zulu");
check("extract v3 id_verifications[0] fullName", idV3.fullName === "Mary Zulu");

// legacy singular id_verification fallback still works
const idA = extractIdentity({
  id_verification: {
    first_name: "Grace",
    last_name: "Mwangi",
    date_of_birth: "1990-01-01",
    document_number: "AB123456",
    document_type: "passport",
  },
});
check("extract snake_case firstName", idA.firstName === "Grace");
check("extract snake_case lastName", idA.lastName === "Mwangi");
check("extract snake_case fullName joined", idA.fullName === "Grace Mwangi");
check("extract snake_case dob", idA.dateOfBirth === "1990-01-01");
check("extract snake_case docNumber", idA.documentNumber === "AB123456");

// camelCase at the top level, only a full_name provided
const idB = extractIdentity({ fullName: "John Banda Phiri" });
check("extract fullName → firstName split", idB.firstName === "John");
check("extract fullName preserved", idB.fullName === "John Banda Phiri");

// garbage inputs never throw, return null
check("extract null on undefined", extractIdentity(undefined) === null);
check("extract null on string", extractIdentity("nope") === null);

// ── 4. summarizeDecision — the shape both consumers read ─────────────────────
const sumApproved = summarizeDecision({
  status: "Approved",
  decision: { first_name: "Grace", last_name: "Mwangi" },
});
check("summarize approved status", sumApproved.status === "approved");
check("summarize approved has verified", sumApproved.verified?.firstName === "Grace");

const sumDeclined = summarizeDecision({ status: "Declined" });
check("summarize declined status", sumDeclined.status === "declined");
check("summarize declined no verified", sumDeclined.verified === undefined);

// approved but identity sitting at the TOP level (no nested `decision`)
const sumFlat = summarizeDecision({ status: "approved", first_name: "Ruth" });
check("summarize approved flat identity", sumFlat.verified?.firstName === "Ruth");

// ── 5. Webhook signature verify: real HMAC round-trip + tamper cases ─────────
const SECRET = "whsec_test_secret";
const body = JSON.stringify({ session_id: "s_1", status: "Approved" });
const rawBody = Buffer.from(body);
const goodSig = crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");

// NOTE: the service reads config.didit.webhookSecret, so point the module's
// config at our test secret for the duration of this check.
const { config } = await import("../src/config/index.js");
config.didit.webhookSecret = SECRET;

check("sig: valid signature accepted", verifyWebhookSignature(rawBody, goodSig) === true);
check(
  "sig: tampered body rejected",
  verifyWebhookSignature(Buffer.from(body + " "), goodSig) === false
);
check(
  "sig: wrong-secret signature rejected",
  verifyWebhookSignature(
    rawBody,
    crypto.createHmac("sha256", "other").update(rawBody).digest("hex")
  ) === false
);
check("sig: non-hex header rejected", verifyWebhookSignature(rawBody, "zzzz") === false);
check("sig: missing header rejected", verifyWebhookSignature(rawBody, undefined) === false);
{
  config.didit.webhookSecret = "";
  check("sig: no configured secret → false", verifyWebhookSignature(rawBody, goodSig) === false);
  config.didit.webhookSecret = SECRET;
}

// ── 6. applyVerifiedIdentity against a fake user (name + idempotency) ─────────
function fakeUser(initial = {}) {
  return {
    name: initial.name ?? "",
    kyc: initial.kyc,
    saved: 0,
    save() {
      this.saved++;
      return Promise.resolve(this);
    },
  };
}

{
  const u = fakeUser({ name: "placeholder" });
  await applyVerifiedIdentity(u, {
    firstName: "Grace",
    fullName: "Grace Mwangi",
    dateOfBirth: "1990-01-01",
    documentNumber: "AB123456",
    documentType: "passport",
  });
  check("apply: user.name = verified first name", u.name === "Grace");
  check("apply: kyc.status verified", u.kyc.status === "verified");
  check("apply: kyc.provider defaults didit", u.kyc.provider === "didit");
  check("apply: kyc.fullName set", u.kyc.fullName === "Grace Mwangi");
  check("apply: dob coerced to Date", u.kyc.dateOfBirth instanceof Date);
  check("apply: saved once", u.saved === 1);

  // Idempotent replay: applying again keeps the same name, still verified.
  await applyVerifiedIdentity(u, { firstName: "Grace", fullName: "Grace Mwangi" });
  check("apply: replay keeps name", u.name === "Grace");
  check("apply: replay stays verified", u.kyc.status === "verified");
}

// fullName-only identity still derives a first name for user.name
{
  const u = fakeUser();
  await applyVerifiedIdentity(u, { fullName: "John Banda" });
  check("apply: derives first name from fullName", u.name === "John");
}

// ── 7. Webhook no-downgrade rule (mirrors webhook.routes.js:161) ─────────────
// A late "declined"/"expired" callback must NOT revoke an already-verified user.
function webhookApply(user, status, identity) {
  if (status === "approved") {
    return applyVerifiedIdentity(user, identity);
  } else if (user.kyc?.status !== "verified") {
    const existing = user.kyc ?? {};
    user.kyc = { ...existing, status: modelStatusFor(status), decisionAt: new Date() };
    return user.save();
  }
  // already verified → ignore late non-approval
  return Promise.resolve(user);
}
{
  const u = fakeUser({ name: "Grace", kyc: { status: "verified", provider: "didit" } });
  await webhookApply(u, "declined");
  check("no-downgrade: verified user stays verified on late decline", u.kyc.status === "verified");

  const p = fakeUser({ kyc: { status: "pending" } });
  await webhookApply(p, "declined");
  check("downgrade: pending user → rejected on decline", p.kyc.status === "rejected");
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
