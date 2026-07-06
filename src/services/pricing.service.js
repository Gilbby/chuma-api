/**
 * Pricing — PURE money math for turning a UI contribution amount into the
 * exact deposit we request from PawaPay.
 *
 * This module is deliberately dependency-free: no DB, no models, no config,
 * no mongoose, no logging, no Date, no randomness. Every input (platformFee,
 * pawapayRate, mnoFee, feesOnEndUser, …) is INJECTED so the logic stays pure
 * and fully unit-testable. Config wiring happens elsewhere, later.
 *
 * THE INVARIANT: the pool always receives EXACTLY `base` — the amount the
 * member typed. Fees and the platform charge never reduce what gets pooled.
 *
 * All internal arithmetic is done in integer ngwee (1 Kwacha = 100 ngwee) to
 * avoid floating-point drift, then converted back to Kwacha (2 dp) on return.
 */

// ─── ngwee helpers ──────────────────────────────────────────────────────────

/** Kwacha → integer ngwee (nearest). */
const toNgwee = (kwacha) => Math.round(kwacha * 100);

/** Integer ngwee → Kwacha (2 dp; exact because ngwee is integer). */
const toKwacha = (ngwee) => ngwee / 100;

/**
 * A fee, in ngwee, rounded UP. We always over-estimate fees so the wallet is
 * never left short — solvency over exactness.
 */
const feeNgweeCeil = (kwacha) => Math.ceil(kwacha * 100);

// ─── the one exported function ──────────────────────────────────────────────

/**
 * @param {object}   p
 * @param {number}   p.base            Amount the member typed (Kwacha, > 0).
 * @param {number}   p.platformFee     Flat platform charge (Kwacha, >= 0), e.g. K2.
 * @param {number}   p.pawapayRate     PawaPay percentage fee, e.g. 0.01 for 1%.
 * @param {boolean}  p.feesOnEndUser   true  = PawaPay bills the payer the MNO+% fee.
 *                                      false = we gross up so base+platformFee survives.
 * @param {function} [p.mnoFee]        (amountKwacha) => MNO fee in Kwacha. Required in
 *                                      gross-up mode; unused when feesOnEndUser === true.
 * @param {boolean}  [p.wholeKwachaOnly] Round depositAmount UP to a whole Kwacha.
 * @returns {{ base:number, platformFee:number, depositAmount:number,
 *             feesCovered:number, pooled:number }}
 */
export function priceContribution({
  base,
  platformFee,
  pawapayRate,
  feesOnEndUser,
  mnoFee,
  wholeKwachaOnly = false,
}) {
  // ── Guards ────────────────────────────────────────────────────────────────
  if (typeof base !== "number" || !Number.isFinite(base) || base <= 0) {
    throw new Error("priceContribution: base must be a finite number > 0");
  }
  if (
    typeof platformFee !== "number" ||
    !Number.isFinite(platformFee) ||
    platformFee < 0
  ) {
    throw new Error("priceContribution: platformFee must be a finite number >= 0");
  }

  const baseNgwee = toNgwee(base);
  const platformFeeNgwee = toNgwee(platformFee);

  // ── Fees billed to the payer: we just request base + platformFee ──────────
  if (feesOnEndUser === true) {
    const depositNgwee = baseNgwee + platformFeeNgwee;
    return {
      base,
      platformFee,
      depositAmount: toKwacha(depositNgwee),
      feesCovered: 0,
      pooled: base, // INVARIANT: the pool gets exactly what was typed.
    };
  }

  // ── Gross-up: solve for the smallest deposit whose net covers netTarget ───
  if (typeof mnoFee !== "function") {
    throw new Error(
      "priceContribution: mnoFee function is required when feesOnEndUser is false"
    );
  }
  if (
    typeof pawapayRate !== "number" ||
    !Number.isFinite(pawapayRate) ||
    pawapayRate < 0
  ) {
    throw new Error("priceContribution: pawapayRate must be a finite number >= 0");
  }

  const netTargetNgwee = baseNgwee + platformFeeNgwee;

  // net(deposit) = deposit - pawapayFee - mnoFee, with BOTH fees rounded up so
  // our estimate of what survives is a lower bound (conservative for solvency).
  const netAt = (depositNgwee) => {
    const pawapayFeeNgwee = Math.ceil(pawapayRate * depositNgwee);
    const mnoFeeNgwee = feeNgweeCeil(mnoFee(toKwacha(depositNgwee)));
    return depositNgwee - pawapayFeeNgwee - mnoFeeNgwee;
  };

  // mnoFee is TIERED, so raising the deposit can raise the fee — this is
  // circular. Iterate: add whatever we're short by, recompute, repeat.
  const MAX_ITERS = 50;
  let depositNgwee = netTargetNgwee;
  let converged = false;
  for (let i = 0; i < MAX_ITERS; i++) {
    const shortfall = netTargetNgwee - netAt(depositNgwee);
    if (shortfall <= 0) {
      converged = true;
      break;
    }
    depositNgwee += shortfall;
  }
  if (!converged) {
    throw new Error(
      "priceContribution: gross-up did not converge within iteration cap"
    );
  }

  // Round the FINAL deposit UP to a whole Kwacha if the provider rejects
  // decimals, then re-check solvency (a tier jump could eat the rounding gain).
  if (wholeKwachaOnly) {
    depositNgwee = Math.ceil(depositNgwee / 100) * 100;
    let whole = false;
    for (let i = 0; i < MAX_ITERS; i++) {
      if (netAt(depositNgwee) >= netTargetNgwee) {
        whole = true;
        break;
      }
      depositNgwee += 100; // bump a whole Kwacha at a time, stay whole
    }
    if (!whole) {
      throw new Error(
        "priceContribution: whole-Kwacha solvency did not converge within iteration cap"
      );
    }
  }

  return {
    base,
    platformFee,
    depositAmount: toKwacha(depositNgwee),
    feesCovered: toKwacha(depositNgwee - netTargetNgwee),
    pooled: base, // INVARIANT: the pool gets exactly what was typed.
  };
}

export default priceContribution;
