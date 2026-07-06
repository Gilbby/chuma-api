import dotenv from "dotenv";
dotenv.config();

const bool = (v, def = false) =>
  v === undefined ? def : String(v).toLowerCase() === "true";
const num = (v, def) => (v === undefined ? def : Number(v));

/**
 * MNO (mobile network operator) fee estimate, in Kwacha, for a deposit of the
 * given Kwacha amount.
 *
 * ⚠️ PLACEHOLDER BANDS — THESE NUMBERS ARE ESTIMATES, NOT REAL TARIFFS. ⚠️
 * They exist only so the gross-up math has something to solve against before we
 * have production data. Replace the tiers below with the real Zambia MNO
 * withdrawal/cash-out schedule from the live PawaPay dashboard before go-live.
 * This is the ONE place fee bands live — tune here, never in the routes.
 */
const mnoFee = (amount) => {
  if (amount <= 50) return 1;
  if (amount <= 150) return 2;
  if (amount <= 500) return 4;
  if (amount <= 1000) return 7;
  return 10;
};

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
    platformFee: num(process.env.PLATFORM_FEE, 2),
    pawapayRate: num(process.env.PAWAPAY_RATE, 0.01),
    feesOnEndUser: bool(process.env.PAWAPAY_FEES_ON_END_USER, false), // Model B default
    wholeKwachaOnly: bool(process.env.PAWAPAY_WHOLE_KWACHA_ONLY, true), // safe default for ZMW
    mnoFee, // injected into priceContribution; bands are placeholders (see above)
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
