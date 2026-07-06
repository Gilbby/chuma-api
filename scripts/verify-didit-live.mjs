/**
 * Live-WIRING smoke test for the Didit KYC service.
 *
 *   npm run verify:didit-live
 *
 * This proves the code will talk to the REAL Didit correctly once credentials
 * are in — WITHOUT a Didit account. It flips DIDIT_ENABLED=true and points
 * DIDIT_BASE_URL at an ephemeral local server that impersonates Didit API v2,
 * then exercises the genuine axios path end-to-end:
 *   - createSession → POST /v2/session/ with the right headers + body, and
 *     parses { session_id, url } out of the response
 *   - retrieveDecision → GET /v2/session/{id}/decision/
 *
 * If Didit changes its v2 endpoints or field names, THIS is the script to update
 * (see the ⚠️ note in src/services/didit.service.js). The captured requests are
 * asserted so a wrong path/header/body fails loudly.
 */

import http from "http";
import crypto from "crypto";

// ── Fake Didit v2 server: records requests, returns canned v2 responses ──────
const captured = [];
const fakeDidit = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    captured.push({
      method: req.method,
      url: req.url,
      apiKey: req.headers["x-api-key"],
      contentType: req.headers["content-type"],
      body: raw ? JSON.parse(raw) : null,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.method === "POST" && req.url === "/v3/session/") {
      res.end(
        JSON.stringify({
          session_id: "sess_abc123",
          url: "https://verify.didit.me/session/sess_abc123",
        })
      );
    } else if (
      req.method === "GET" &&
      req.url === "/v3/session/sess_abc123/decision/"
    ) {
      // v3 decision report: identity lives in the id_verifications array.
      res.end(
        JSON.stringify({
          status: "Approved",
          id_verifications: [{ first_name: "Grace", last_name: "Mwangi" }],
        })
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found", url: req.url }));
    }
  });
});

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

await new Promise((r) => fakeDidit.listen(0, "127.0.0.1", r));
const { port } = fakeDidit.address();

// Env MUST be set before importing config (dotenv.config does not override
// existing process.env, so these win over .env).
process.env.DIDIT_ENABLED = "true";
process.env.DIDIT_BASE_URL = `http://127.0.0.1:${port}`;
process.env.DIDIT_API_KEY = "test_api_key";
process.env.DIDIT_WORKFLOW_ID = "wf_test_123";
process.env.DIDIT_WEBHOOK_SECRET = "whsec_test";
process.env.DIDIT_VERIFY_WEBHOOKS = "true";

const { createSession, retrieveDecision, summarizeDecision } = await import(
  "../src/services/didit.service.js"
);
const { config } = await import("../src/config/index.js");

// Sanity: config actually picked up our overrides (i.e. we're on the live path).
check("config.didit.enabled === true", config.didit.enabled === true);
check("config.didit.baseUrl points at fake", config.didit.baseUrl === `http://127.0.0.1:${port}`);

// ── createSession → POST /v2/session/ ────────────────────────────────────────
const session = await createSession({
  userId: "user_42",
  returnUrl: "chuma://kyc-return",
});
check("createSession returns sessionId", session.sessionId === "sess_abc123");
check(
  "createSession returns hosted url",
  session.url === "https://verify.didit.me/session/sess_abc123"
);

const postReq = captured.find((c) => c.method === "POST");
check("POST hit /v3/session/", postReq?.url === "/v3/session/");
check("POST sent x-api-key header", postReq?.apiKey === "test_api_key");
check("POST sent JSON content-type", /application\/json/.test(postReq?.contentType || ""));
check("POST body has workflow_id from config", postReq?.body?.workflow_id === "wf_test_123");
check("POST body vendor_data = userId (string)", postReq?.body?.vendor_data === "user_42");
check("POST body callback = returnUrl", postReq?.body?.callback === "chuma://kyc-return");

// ── retrieveDecision → GET /v2/session/{id}/decision/ ────────────────────────
const decision = await retrieveDecision("sess_abc123");
const getReq = captured.find((c) => c.method === "GET");
check("GET hit /v3/session/{id}/decision/", getReq?.url === "/v3/session/sess_abc123/decision/");
check("GET sent x-api-key header", getReq?.apiKey === "test_api_key");

// The decision flows through summarizeDecision exactly as /kyc/status uses it.
const summary = summarizeDecision(decision);
check("decision summarized → approved", summary.status === "approved");
check("decision summarized → verified name", summary.verified?.firstName === "Grace");

// ── URL-encoding safety on the session id path ───────────────────────────────
captured.length = 0;
await retrieveDecision("weird id/../x").catch(() => {});
const encReq = captured.find((c) => c.method === "GET");
check(
  "GET encodes the session id in the path",
  encReq?.url === `/v3/session/${encodeURIComponent("weird id/../x")}/decision/`
);

await new Promise((r) => fakeDidit.close(r));

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log("");
if (failures.length === 0) {
  console.log(`PASS (${passed}/${total})`);
  process.exit(0);
} else {
  console.log(`FAIL (${passed}/${total}) — ${failures.length} failed`);
  process.exit(1);
}
