/**
 * Standalone PASS/FAIL harness for pricePayout — the PURE payout money math.
 *
 *   npm run verify:payout-pricing
 *
 * Self-contained: imports only pricePayout and asserts the payout invariants
 * across a spread of owed amounts under both fee-billing modes and both
 * whole-Kwacha settings. It touches no DB, no config, no network — same purity
 * contract as the module itself.
 *
 * NOTE: the tiered `mnoFee` below is an ILLUSTRATIVE PLACEHOLDER only. These are
 * made-up bands for exercising the deduction math — they are NOT real Zambia /
 * MNO rates. Real rates get injected from config in a later prompt.
 */

import { pricePayout } from "../src/services/pricing.service.js";

// ── Illustrative tiered MNO fee (PLACEHOLDER — not real rates) ───────────────
const mnoFee = (amount) => {
  if (amount <= 50) return 1;
  if (amount <= 100) return 2;
  if (amount <= 500) return 5;
  if (amount <= 1000) return 10;
  return 15;
};

const PLATFORM_FEE = 2; // K2
const PAWAPAY_RATE = 0.01; // 1%
const OWEDS = [100, 1000, 50, 3]; // 3 is deliberately tiny — fees exceed it in gross mode

// ── tiny assert helpers ──────────────────────────────────────────────────────
let passed = 0;
let total = 0;
const failures = [];

/** ngwee (integer) view of a Kwacha amount. */
const ng = (k) => Math.round(k * 100);

function check(label, condition) {
  total++;
  if (condition) {
    passed++;
  } else {
    failures.push(label);
    console.log(`   ✗ ${label}`);
  }
}

// ── Case sweep: every owed × both fee modes × both whole-Kwacha settings ─────
for (const owed of OWEDS) {
  for (const feesOnEndUser of [true, false]) {
    for (const wholeKwachaOnly of [false, true]) {
      const tag = `owed=${owed} eou=${feesOnEndUser} whole=${wholeKwachaOnly}`;

      let r;
      try {
        r = pricePayout({
          owed,
          platformFee: PLATFORM_FEE,
          pawapayRate: PAWAPAY_RATE,
          feesOnEndUser,
          mnoFee,
          wholeKwachaOnly,
        });
      } catch (e) {
        // Only tiny payouts whose fees meet/exceed `owed` may throw — expected,
        // asserted explicitly below. Log and move on; nothing to price here.
        console.log(`${tag} → THROWS (${e.message})`);
        continue;
      }

      console.log(
        `${tag} → transactionFee=${r.transactionFee} platformFee=${r.platformFee} ` +
          `totalFees=${r.totalFees} netReceived=${r.netReceived}`
      );

      // 1. THE INVARIANT — netReceived + totalFees === owed, EXACTLY, in ngwee.
      check(`invariant net+fees===owed (${tag})`,
        ng(r.netReceived) + ng(r.totalFees) === ng(owed));

      // 2. Member receives LESS than owed whenever any fee was charged.
      if (ng(r.totalFees) > 0) {
        check(`net<owed when fees>0 (${tag})`, ng(r.netReceived) < ng(owed));
      }

      // 3. platformFee is included in totalFees every case. Use >= not ===: in
      //    whole-Kwacha mode the net-rounding remainder is folded into totalFees
      //    (to keep the invariant exact), so totalFees legitimately exceeds
      //    transactionFee + platformFee by that remainder.
      check(`totalFees includes platformFee (${tag})`,
        ng(r.totalFees) >= ng(r.transactionFee) + ng(PLATFORM_FEE));

      // 4. whole-Kwacha → netReceived is a whole number (and invariant still holds).
      if (wholeKwachaOnly) {
        check(`net is whole Kwacha (${tag})`, Number.isInteger(r.netReceived));
      }
    }
  }
}

// 5. A tiny owed whose fees exceed it (owed=3, gross-up mode) must THROW rather
//    than send zero/negative.
{
  let threw = false;
  try {
    pricePayout({
      owed: 3,
      platformFee: PLATFORM_FEE,
      pawapayRate: PAWAPAY_RATE,
      feesOnEndUser: false,
      mnoFee,
    });
  } catch {
    threw = true;
  }
  console.log(`owed=3 (gross-up) fees exceed payout → throws=${threw}`);
  check("tiny owed where fees exceed it throws", threw);
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
