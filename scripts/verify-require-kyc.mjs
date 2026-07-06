/**
 * Offline PASS/FAIL harness for the requireKyc middleware gate.
 *
 *   npm run verify:require-kyc
 *
 * No DB, no network. Drives the middleware with fake req/res objects across the
 * KYC status vocabulary and asserts the gate only lets `verified` users through
 * and returns a 403 { code: "needs_kyc" } for everyone else.
 */

import { requireKyc } from "../src/middleware/auth.js";

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

// Minimal Express-style req/res doubles.
function run(user) {
  let nextCalled = false;
  let statusCode = null;
  let jsonBody = null;
  const req = { user };
  const res = {
    status(c) {
      statusCode = c;
      return this;
    },
    json(b) {
      jsonBody = b;
      return this;
    },
  };
  requireKyc(req, res, () => {
    nextCalled = true;
  });
  return { nextCalled, statusCode, jsonBody };
}

// verified → passes through
{
  const r = run({ kyc: { status: "verified" } });
  check("verified: calls next()", r.nextCalled === true);
  check("verified: no status set", r.statusCode === null);
}

// every non-verified status → 403 needs_kyc, next() NOT called
for (const status of ["incomplete", "pending", "rejected", "in_review", undefined]) {
  const r = run({ kyc: status ? { status } : undefined });
  check(`${status}: does NOT call next()`, r.nextCalled === false);
  check(`${status}: 403`, r.statusCode === 403);
  check(`${status}: code needs_kyc`, r.jsonBody?.code === "needs_kyc");
}

// user with no kyc object at all → blocked
{
  const r = run({});
  check("no kyc field: blocked 403", r.statusCode === 403 && r.nextCalled === false);
  check("no kyc field: kycStatus incomplete", r.jsonBody?.kycStatus === "incomplete");
}

// no user at all (defensive) → blocked, never throws
{
  const r = run(undefined);
  check("no user: blocked 403", r.statusCode === 403 && r.nextCalled === false);
}

console.log("");
if (failures.length === 0) {
  console.log(`PASS (${passed}/${total})`);
  process.exit(0);
} else {
  console.log(`FAIL (${passed}/${total}) — ${failures.length} failed`);
  process.exit(1);
}
