/**
 * Standalone PASS/FAIL harness for the PURE pricing module.
 *
 *   npm run verify:pricing
 *
 * Self-contained: it imports only priceContribution and asserts the money
 * invariants across a spread of bases under both fee-billing modes. It touches
 * no DB, no config, no network — same purity contract as the module itself.
 *
 * NOTE: the tiered `mnoFee` below is an ILLUSTRATIVE PLACEHOLDER only. These are
 * made-up bands for exercising the tier-crossing math — they are NOT real
 * Zambia / MNO rates. Real rates get injected from config in a later prompt.
 */

import { priceContribution } from "../src/services/pricing.service.js";

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
const BASES = [10, 100, 500, 999.5];

// ── tiny assert helpers ──────────────────────────────────────────────────────
let passed = 0;
let total = 0;
const failures = [];

/** Compare two Kwacha amounts at 2-dp (ngwee) precision. */
const eqMoney = (a, b) => Math.round(a * 100) === Math.round(b * 100);

function check(label, condition) {
  total++;
  if (condition) {
    passed++;
  } else {
    failures.push(label);
    console.log(`   ✗ ${label}`);
  }
}

// ── Case sweep: every base × both fee modes ──────────────────────────────────
for (const base of BASES) {
  for (const feesOnEndUser of [true, false]) {
    for (const wholeKwachaOnly of [false, true]) {
      const r = priceContribution({
        base,
        platformFee: PLATFORM_FEE,
        pawapayRate: PAWAPAY_RATE,
        feesOnEndUser,
        mnoFee,
        wholeKwachaOnly,
      });

      const netTarget = base + PLATFORM_FEE;
      // Actual wallet net using EXACT provider fees (module rounds fees up, so
      // real net should always land at or above the module's conservative one).
      const walletNet =
        r.depositAmount - PAWAPAY_RATE * r.depositAmount - mnoFee(r.depositAmount);

      console.log(
        `base=${base} feesOnEndUser=${feesOnEndUser} wholeKwachaOnly=${wholeKwachaOnly} ` +
          `→ deposit=${r.depositAmount} feesCovered=${r.feesCovered} ` +
          `pooled=${r.pooled} walletNet=${walletNet.toFixed(4)}`
      );

      // 1. THE INVARIANT — pooled is EXACTLY base, every single case.
      check(`pooled===base (base=${base}, eou=${feesOnEndUser}, whole=${wholeKwachaOnly})`, r.pooled === base);

      // 4. Member is never charged less than what they owe.
      check(
        `deposit>=base+platformFee (base=${base}, eou=${feesOnEndUser}, whole=${wholeKwachaOnly})`,
        r.depositAmount + 1e-9 >= netTarget
      );

      if (feesOnEndUser) {
        // 2. Fees-on-payer: we request exactly base + platformFee.
        check(
          `deposit===base+platformFee (base=${base}, whole=${wholeKwachaOnly})`,
          eqMoney(r.depositAmount, netTarget)
        );
      } else {
        // 3. Gross-up: the wallet net must cover base + platformFee.
        check(
          `walletNet>=base+platformFee (base=${base}, whole=${wholeKwachaOnly})`,
          walletNet + 1e-9 >= netTarget
        );
      }

      // 5. Whole-Kwacha rounding yields an integer deposit. This is defined as
      //    the final step of the GROSS-UP path only — in fees-on-payer mode the
      //    deposit passes through as exactly base+platformFee (assertion 2), so
      //    a fractional base+platformFee (e.g. 999.5+2) is intentionally NOT
      //    rounded there. Assert integer-ness only where the module guarantees it.
      if (wholeKwachaOnly && !feesOnEndUser) {
        check(
          `deposit is integer (base=${base})`,
          Number.isInteger(r.depositAmount)
        );
      }
    }
  }
}

// 6. base <= 0 throws.
{
  let threw = false;
  try {
    priceContribution({
      base: 0,
      platformFee: PLATFORM_FEE,
      pawapayRate: PAWAPAY_RATE,
      feesOnEndUser: false,
      mnoFee,
    });
  } catch {
    threw = true;
  }
  console.log(`base<=0 throws → ${threw}`);
  check("base<=0 throws", threw);
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
