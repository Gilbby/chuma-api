import dotenv from "dotenv";
dotenv.config();

const bool = (v, def = false) =>
  v === undefined ? def : String(v).toLowerCase() === "true";
const num = (v, def) => (v === undefined ? def : Number(v));

/**
 * Fees (Zambia) — pawaPay MERCHANT charges (per pawapay.io/fees) plus our 1%
 * platform. TOTAL charge = pawaPay's fee + 1% platform. This is the ONE place
 * fee bands live — tune here, never in the routes. Everything is per-operator,
 * keyed by the PawaPay correspondent code providerFromPhone() returns.
 *
 *   • Collections (money IN): pawaPay charges a flat MMO fee (per operator) + 1%.
 *       mnoFee = collectionFeeFor(correspondent);  pawapayRate = 1% (collections).
 *   • Disbursements (money OUT): Airtel = 1%; MTN = 2% + e-levy; Zamtel = 2%.
 *       pawapayRate = payoutRateFor(correspondent) (1% Airtel / 2% MTN & Zamtel);
 *       mnoFee = payoutLevyFor(correspondent) — the e-levy, MTN ONLY (0 otherwise).
 *   • pawaPay also lists a separate "fees paid by your customers" (a small MMO
 *     charge the member's OWN wallet bears) — NOT included here: it doesn't reduce
 *     our settlement, it's the member's direct cost. See note if we ever surface it.
 *
 * Payout receive ceiling: an account can't receive more than PAYOUT_CEILING in
 * one transfer, so larger payouts are SPLIT (see splitForPayout). The MTN e-levy
 * is per-TRANSACTION, so on a split payout it STACKS per chunk; the % base is
 * linear (handled by pawapayRate) and needs no stacking.
 *
 * ⚠️ pawapay.io/fees is pawaPay's STANDARD public pricing — confirm against your
 *    merchant dashboard's active rates before go-live.
 */

const bandFee = (bands, amount) =>
  (bands.find((b) => amount <= b.upTo) || bands[bands.length - 1]).fee;

// ── COLLECTIONS: flat MMO fee pawaPay adds to its 1%, per operator ──
const AIRTEL_COLLECTION = [
  // amount ≤ upTo (ZMW)  →  flat fee (ZMW), on top of pawaPay's 1%
  { upTo: 150, fee: 0.5 },
  { upTo: 500, fee: 1 },
  { upTo: 1000, fee: 1.5 },
  { upTo: 3000, fee: 2.8 },
  { upTo: 5000, fee: 4 },
  { upTo: Infinity, fee: 5.5 },
];
const MTN_COLLECTION = [
  { upTo: 150, fee: 0.42 },
  { upTo: 300, fee: 0.9 },
  { upTo: 500, fee: 0.8 },
  { upTo: 1000, fee: 1 },
  { upTo: 3000, fee: 2.2 },
  { upTo: 5000, fee: 3 },
  { upTo: Infinity, fee: 4 },
];
const ZAMTEL_COLLECTION = [
  { upTo: 150, fee: 0.42 },
  { upTo: 300, fee: 0.8 },
  { upTo: 500, fee: 0.9 },
  { upTo: 1000, fee: 1 },
  { upTo: 3000, fee: 2 },
  { upTo: 5000, fee: 3 },
  { upTo: 10000, fee: 4 },
  { upTo: Infinity, fee: 5 },
];
const COLLECTION_BY_OPERATOR = {
  AIRTEL_OAPI_ZMB: AIRTEL_COLLECTION,
  MTN_MOMO_ZMB: MTN_COLLECTION,
  ZAMTEL_ZMB: ZAMTEL_COLLECTION,
};

// mnoFee for a CONTRIBUTION: pawaPay's flat collection fee (the 1% is pawapayRate).
const collectionFeeFor = (correspondent) => {
  const bands = COLLECTION_BY_OPERATOR[correspondent] || MTN_COLLECTION;
  return (amount) => bandFee(bands, amount);
};

// ── "Fees paid by your customers": the MMO's OWN charge to the MEMBER's wallet
// on a COLLECTION (money in), separate from our merchant fee above. We never
// collect it — it's shown to the member as a heads-up (receipt / review tab).
// Disbursements are "No fees" to receive, so this only applies to money IN.
const AIRTEL_CUSTOMER_COLLECTION = [
  { upTo: 500, fee: 2 },
  { upTo: 10000, fee: 5 },
];
const MTN_CUSTOMER_COLLECTION = [
  { upTo: 150, fee: 2.16 },
  { upTo: 300, fee: 2.2 },
  { upTo: 500, fee: 2.4 },
  { upTo: 1000, fee: 6 },
  { upTo: 3000, fee: 6.6 },
  { upTo: 5000, fee: 7 },
  { upTo: 10000, fee: 8 },
];
const ZAMTEL_CUSTOMER_COLLECTION = [
  { upTo: 150, fee: 0.08 },
  { upTo: 300, fee: 0.1 },
  { upTo: 500, fee: 0.2 },
  { upTo: 1000, fee: 0.5 },
  { upTo: 3000, fee: 0.8 },
  { upTo: 5000, fee: 1 },
  { upTo: 10000, fee: 1.5 },
];
const CUSTOMER_COLLECTION_BY_OPERATOR = {
  AIRTEL_OAPI_ZMB: AIRTEL_CUSTOMER_COLLECTION,
  MTN_MOMO_ZMB: MTN_CUSTOMER_COLLECTION,
  ZAMTEL_ZMB: ZAMTEL_CUSTOMER_COLLECTION,
};

// The member's OWN network fee on a contribution/repayment (money in), charged
// to their wallet by their MMO. Display-only — NOT part of what we charge.
const customerFeeFor = (correspondent) => {
  const bands = CUSTOMER_COLLECTION_BY_OPERATOR[correspondent] || MTN_CUSTOMER_COLLECTION;
  return (amount) => bandFee(bands, amount);
};

// ── DISBURSEMENTS: pawaPay % (per operator) + MTN e-levy ──
// pawaPay payout commission: Airtel 1%, MTN 2%, Zamtel 2%.
const PAYOUT_RATE_BY_OPERATOR = {
  AIRTEL_OAPI_ZMB: 0.01,
  MTN_MOMO_ZMB: 0.02,
  ZAMTEL_ZMB: 0.02,
};
const payoutRateFor = (correspondent) => PAYOUT_RATE_BY_OPERATOR[correspondent] ?? 0.02;

// MTN e-levy, charged per transaction on disbursements (Airtel has none). Caps at
// K8 — the bandFee fallback returns the top band for anything above K10,000.
const MTN_PAYOUT_LEVY = [
  { upTo: 150, fee: 0.32 },
  { upTo: 300, fee: 0.4 },
  { upTo: 500, fee: 0.8 },
  { upTo: 1000, fee: 2 },
  { upTo: 3000, fee: 4 },
  { upTo: 5000, fee: 7.5 },
  { upTo: 10000, fee: 8 },
];

// A mobile account can't receive more than this in ONE transfer; larger payouts
// are split into ≤ceiling chunks (see splitForPayout).
const PAYOUT_CEILING = num(process.env.PAYOUT_CEILING, 20000);

// mnoFee for a DISBURSEMENT: the e-levy. Per pawaPay, ONLY MTN payouts carry it;
// Airtel (1%) and Zamtel (2%) have none. Per-transaction, so above the receive
// ceiling it STACKS per chunk — matching how the payout is actually split. The %
// base (pawapayRate) is linear, so it is NOT stacked here.
const payoutLevyFor = (correspondent) => {
  const hasLevy = correspondent === "MTN_MOMO_ZMB"; // e-levy on MTN payouts only
  return (amount) => {
    if (!hasLevy) return 0;
    if (amount <= PAYOUT_CEILING) return bandFee(MTN_PAYOUT_LEVY, amount);
    const blocks = Math.floor(amount / PAYOUT_CEILING);
    const remainder = amount - blocks * PAYOUT_CEILING;
    return (
      blocks * bandFee(MTN_PAYOUT_LEVY, PAYOUT_CEILING) +
      (remainder > 0 ? bandFee(MTN_PAYOUT_LEVY, remainder) : 0)
    );
  };
};

// Split a payout above the receive ceiling into ≤ceiling transfers summing
// EXACTLY to `amount`. ≤ceiling → a single transfer. Chunks are evenly sized (no
// sub-minimum sliver) and whole-Kwacha when `amount` is: leftover Kwacha are
// spread one-each across the first chunks; any sub-Kwacha remainder parks on the
// last. `correspondent` is accepted for API symmetry; the ceiling is uniform.
const splitForPayout = (amount, _correspondent) => {
  if (amount <= PAYOUT_CEILING) return [amount];
  const n = Math.ceil(amount / PAYOUT_CEILING);
  const whole = Math.floor(amount);
  const base = Math.floor(whole / n);
  const extra = whole - base * n;
  const chunks = Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
  const frac = Math.round((amount - whole) * 100) / 100;
  if (frac > 0) chunks[chunks.length - 1] += frac;
  return chunks;
};

// Contribution platform fee is a PERCENTAGE of the amount (unlike payout flows,
// which still use the flat `platformFee` below). Rounded to ngwee (2 dp).
const platformFeeRate = num(process.env.PLATFORM_FEE_RATE, 0.01);
const platformFeeFor = (amount) => Math.round(amount * platformFeeRate * 100) / 100;

export const config = {
  env: process.env.NODE_ENV || "development",
  port: num(process.env.PORT, 5000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:5000",

  mongoUri: process.env.MONGODB_URI || "mongodb://localhost:27017/chuma",

  jwt: {
    secret: process.env.JWT_SECRET || "dev_insecure_secret_change_me",
    expiresIn: process.env.JWT_EXPIRES_IN || "72h",
  },
  otp: {
    length: num(process.env.OTP_LENGTH, 6),
    expiryMinutes: num(process.env.OTP_EXPIRY_MINUTES, 5),
  },

  africasTalking: {
    username: process.env.AT_USERNAME || "sandbox",
    apiKey: process.env.AT_API_KEY || "",
    senderId: process.env.AT_SENDER_ID || "",
    smsEnabled: bool(process.env.SMS_ENABLED, false),
  },

  pawapay: {
    baseUrl: process.env.PAWAPAY_BASE_URL || "https://api.sandbox.pawapay.io",
    apiToken: process.env.PAWAPAY_API_TOKEN || "",
    depositCallbackUrl:
      process.env.PAWAPAY_DEPOSIT_CALLBACK_URL ||
      "http://localhost:5000/api/webhooks/pawapay/deposit",
    payoutCallbackUrl:
      process.env.PAWAPAY_PAYOUT_CALLBACK_URL ||
      "http://localhost:5000/api/webhooks/pawapay/payout",
    paymentsEnabled: bool(process.env.PAYMENTS_ENABLED, false),
    verifyCallbacks: bool(
      process.env.PAWAPAY_VERIFY_CALLBACKS,
      bool(process.env.PAYMENTS_ENABLED, false) // fail-safe: defaults ON whenever real payments are on
    ),
  },

  kyc: {
    baseUrl: process.env.KYC_PROVIDER_BASE_URL || "",
    apiKey: process.env.KYC_PROVIDER_API_KEY || "",
    enabled: bool(process.env.KYC_ENABLED, false),
  },

  // Didit.me identity verification. When DIDIT_ENABLED is false the KYC routes
  // run in simulated mode (no external calls) so onboarding works in dev.
  didit: {
    baseUrl: process.env.DIDIT_BASE_URL || "https://verification.didit.me",
    apiKey: process.env.DIDIT_API_KEY || "",
    workflowId: process.env.DIDIT_WORKFLOW_ID || "",
    webhookSecret: process.env.DIDIT_WEBHOOK_SECRET || "",
    enabled: bool(process.env.DIDIT_ENABLED, false),
    verifyWebhooks: bool(
      process.env.DIDIT_VERIFY_WEBHOOKS,
      bool(process.env.DIDIT_ENABLED, false) // on by default whenever Didit is live
    ),
  },

  pricing: {
    platformFee: num(process.env.PLATFORM_FEE, 2), // flat — loan-disbursement absorb path
    platformRate: platformFeeRate, // our platform percentage (1%) — both flows
    platformFeeFor, // (amount) => our 1% platform fee
    pawapayRate: num(process.env.PAWAPAY_RATE, 0.01), // pawaPay % on COLLECTIONS (1%)
    feesOnEndUser: bool(process.env.PAWAPAY_FEES_ON_END_USER, false), // Model B default
    wholeKwachaOnly: bool(process.env.PAWAPAY_WHOLE_KWACHA_ONLY, true), // safe default for ZMW

    // pawaPay merchant fees (see fee section above):
    collectionFeeFor, // (correspondent) => (amount) => flat collection fee (money IN)
    payoutRateFor, // (correspondent) => pawaPay payout % (1% Airtel / 2% MTN)
    payoutLevyFor, // (correspondent) => (amount) => e-levy on payout (0 Airtel / MTN levy)
    splitForPayout, // (amount) => [chunks] each ≤ receive ceiling, summing to amount
    customerFeeFor, // (correspondent) => (amount) => member's OWN network fee (display-only, money IN)

    // A contribution's deposit request is rounded UP to a whole Kwacha, matching
    // payouts (`wholeKwachaOnly`). Set CONTRIB_WHOLE_KWACHA=false for exact-ngwee
    // deposits.
    contributionWholeKwacha: bool(process.env.CONTRIB_WHOLE_KWACHA, true),
  },

  rules: {
    groupMonthlyFee: num(process.env.GROUP_MONTHLY_FEE, 100),
    graceDays: num(process.env.GROUP_FEE_GRACE_DAYS, 5),
    currency: process.env.CURRENCY || "ZMW",
    country: process.env.COUNTRY || "ZMB",
  },

  corsOrigins: (process.env.CORS_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim()),
};

// Refuse to start in production with insecure defaults — a forged JWT or an
// open CORS policy is unrecoverable once real money is moving.
if (config.env === "production") {
  const fatal = [];
  if (!process.env.JWT_SECRET) fatal.push("JWT_SECRET must be set");
  if (config.corsOrigins.includes("*"))
    fatal.push("CORS_ORIGINS must list explicit origins (no *)");
  if (config.pawapay.paymentsEnabled && !config.pawapay.apiToken)
    fatal.push("PAWAPAY_API_TOKEN must be set when PAYMENTS_ENABLED=true");
  if (config.pawapay.paymentsEnabled && !config.pawapay.verifyCallbacks)
    fatal.push("PAWAPAY_VERIFY_CALLBACKS must not be disabled when PAYMENTS_ENABLED=true");
  if (config.didit.enabled && (!config.didit.apiKey || !config.didit.workflowId))
    fatal.push("DIDIT_API_KEY and DIDIT_WORKFLOW_ID must be set when DIDIT_ENABLED=true");
  if (config.didit.enabled && config.didit.verifyWebhooks && !config.didit.webhookSecret)
    fatal.push("DIDIT_WEBHOOK_SECRET must be set when Didit webhook verification is on");
  if (config.africasTalking.smsEnabled && !config.africasTalking.apiKey)
    fatal.push("AT_API_KEY must be set when SMS_ENABLED=true");
  if (fatal.length) {
    console.error("✗ Refusing to start in production:\n  - " + fatal.join("\n  - "));
    process.exit(1);
  }
}

export default config;
