import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import config from "../config/index.js";

/**
 * PawaPay payment service (Merchant API v2).
 *
 * Docs: https://docs.pawapay.io
 *
 * - DEPOSIT  = collect money FROM a member's wallet INTO the group/merchant
 *              (contributions, loan repayments, group fees). Member approves
 *              with their mobile money PIN.
 * - PAYOUT   = send money FROM the merchant TO a member's wallet
 *              (loan disbursements, share-out distributions).
 *
 * When PAYMENTS_ENABLED=true and PAWAPAY_API_TOKEN is set, real API calls are
 * made. When false (default dev mode), calls are simulated as ACCEPTED so the
 * full flow works locally without real money.
 *
 * The API is ASYNCHRONOUS: initiating returns ACCEPTED/REJECTED. The FINAL
 * status (COMPLETED/FAILED) arrives via callback to your webhook URLs, or by
 * polling the status endpoints below. Use ngrok to expose your webhook URLs
 * to PawaPay during testing.
 */

const ENABLED = () => config.pawapay.paymentsEnabled;

function client() {
  return axios.create({
    baseURL: config.pawapay.baseUrl,
    headers: {
      Authorization: `Bearer ${config.pawapay.apiToken}`,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
}

/**
 * Map a Zambian phone number to a PawaPay provider (correspondent) code.
 * Prefixes: MTN 076/096, Airtel 077/097, Zamtel 075/095.
 */
export function providerFromPhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  const core = digits.startsWith("260") ? digits.slice(3) : digits.replace(/^0/, "");
  const prefix = core.slice(0, 2);
  if (prefix === "76" || prefix === "96") return "MTN_MOMO_ZMB";
  if (prefix === "77" || prefix === "97") return "AIRTEL_ZMB";
  if (prefix === "75" || prefix === "95") return "ZAMTEL_ZMB";
  return "MTN_MOMO_ZMB"; // sensible default; caller can override
}

/** Normalise phone to MSISDN (260XXXXXXXXX, no plus). */
export function toMsisdn(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("260")) return digits;
  if (digits.startsWith("0")) return "260" + digits.slice(1);
  return digits;
}

/**
 * Initiate a DEPOSIT (collect from member).
 * @returns {Promise<{ id, status, simulated?, raw? }>}
 */
export async function initiateDeposit({
  amount,
  phone,
  provider,
  statementDescription = "Chuma payment",
  metadata = [],
}) {
  const depositId = uuidv4();
  const msisdn = toMsisdn(phone);
  const correspondent = provider || providerFromPhone(phone);

  if (!ENABLED()) {
    console.log(
      `[PAYMENT SIMULATED] DEPOSIT ${amount} ${config.rules.currency} from ${msisdn} via ${correspondent}`
    );
    return { id: depositId, status: "ACCEPTED", simulated: true };
  }

  const body = {
    depositId,
    amount: String(amount),
    currency: config.rules.currency,
    correspondent,
    payer: { type: "MSISDN", address: { value: msisdn } },
    customerTimestamp: new Date().toISOString(),
    statementDescription: statementDescription.slice(0, 22),
    country: config.rules.country,
    metadata,
  };

  try {
    const { data } = await client().post("/deposits", body);
    return { id: depositId, status: data.status, raw: data };
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error("[PAWAPAY] deposit error:", detail);
    return { id: depositId, status: "REJECTED", error: detail };
  }
}

/**
 * Initiate a PAYOUT (send to member).
 */
export async function initiatePayout({
  amount,
  phone,
  provider,
  statementDescription = "Chuma payout",
  metadata = [],
}) {
  const payoutId = uuidv4();
  const msisdn = toMsisdn(phone);
  const correspondent = provider || providerFromPhone(phone);

  if (!ENABLED()) {
    console.log(
      `[PAYMENT SIMULATED] PAYOUT ${amount} ${config.rules.currency} to ${msisdn} via ${correspondent}`
    );
    return { id: payoutId, status: "ACCEPTED", simulated: true };
  }

  const body = {
    payoutId,
    amount: String(amount),
    currency: config.rules.currency,
    correspondent,
    recipient: { type: "MSISDN", address: { value: msisdn } },
    customerTimestamp: new Date().toISOString(),
    statementDescription: statementDescription.slice(0, 22),
    country: config.rules.country,
    metadata,
  };

  try {
    const { data } = await client().post("/payouts", body);
    return { id: payoutId, status: data.status, raw: data };
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error("[PAWAPAY] payout error:", detail);
    return { id: payoutId, status: "REJECTED", error: detail };
  }
}

/** Poll a deposit's final status. */
export async function checkDepositStatus(depositId) {
  if (!ENABLED()) return { status: "COMPLETED", simulated: true };
  try {
    const { data } = await client().get(`/deposits/${depositId}`);
    return Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error("[PAWAPAY] check deposit error:", err?.response?.data || err.message);
    return { status: "UNKNOWN" };
  }
}

/** Poll a payout's final status. */
export async function checkPayoutStatus(payoutId) {
  if (!ENABLED()) return { status: "COMPLETED", simulated: true };
  try {
    const { data } = await client().get(`/payouts/${payoutId}`);
    return Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error("[PAWAPAY] check payout error:", err?.response?.data || err.message);
    return { status: "UNKNOWN" };
  }
}

/** Predict provider from a phone number using PawaPay (validates the number). */
export async function predictProvider(phone) {
  if (!ENABLED()) {
    return { provider: providerFromPhone(phone), phoneNumber: toMsisdn(phone) };
  }
  try {
    const { data } = await client().post("/v2/predict-provider", {
      phoneNumber: toMsisdn(phone),
    });
    return data;
  } catch (err) {
    return { provider: providerFromPhone(phone), phoneNumber: toMsisdn(phone) };
  }
}

export default {
  initiateDeposit,
  initiatePayout,
  checkDepositStatus,
  checkPayoutStatus,
  predictProvider,
  providerFromPhone,
  toMsisdn,
};
