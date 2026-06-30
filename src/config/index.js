import dotenv from "dotenv";
dotenv.config();

const bool = (v, def = false) =>
  v === undefined ? def : String(v).toLowerCase() === "true";
const num = (v, def) => (v === undefined ? def : Number(v));

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
  },

  kyc: {
    baseUrl: process.env.KYC_PROVIDER_BASE_URL || "",
    apiKey: process.env.KYC_PROVIDER_API_KEY || "",
    enabled: bool(process.env.KYC_ENABLED, false),
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

export default config;
