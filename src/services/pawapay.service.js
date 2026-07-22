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
  if (prefix === "77" || prefix === "97") return "AIRTEL_OAPI_ZMB";
  if (prefix === "75" || prefix === "95") return "ZAMTEL_ZMB";
  return "MTN_MOMO_ZMB"; // sensible default; caller can override
}

/**
 * PawaPay statement descriptions must be 4-22 chars, alphanumeric and spaces
 * ONLY — anything else (e.g. a hyphen) gets the whole payment REJECTED with
 * PARAMETER_INVALID. Sanitise centrally so no call site can slip one through.
 */
function toStatementDescription(text, fallback) {
  const clean = String(text ?? "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 22);
  return clean.length >= 4 ? clean : fallback;
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
    statementDescription: toStatementDescription(statementDescription, "Chuma payment"),
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
 * Send ONE payout transfer (no splitting). Returns a transfer record:
 *   { payoutId, amount, status, failureReason? }
 * status: COMPLETED (simulated) / ACCEPTED (live, awaiting callback) / REJECTED.
 */
async function sendOneTransfer({ amount, msisdn, correspondent, statementDescription, metadata }) {
  const payoutId = uuidv4();
  if (!ENABLED()) {
    console.log(
      `[PAYMENT SIMULATED] PAYOUT ${amount} ${config.rules.currency} to ${msisdn} via ${correspondent}`
    );
    return { payoutId, amount, status: "COMPLETED" };
  }
  const body = {
    payoutId,
    amount: String(amount),
    currency: config.rules.currency,
    correspondent,
    recipient: { type: "MSISDN", address: { value: msisdn } },
    customerTimestamp: new Date().toISOString(),
    statementDescription: toStatementDescription(statementDescription, "Chuma payout"),
    country: config.rules.country,
    metadata,
  };
  try {
    const { data } = await client().post("/payouts", body);
    return { payoutId, amount, status: data.status };
  } catch (err) {
    const detail = err?.response?.data || err.message;
    console.error("[PAWAPAY] payout error:", detail);
    return { payoutId, amount, status: "REJECTED", failureReason: JSON.stringify(detail) };
  }
}

/**
 * Initiate a PAYOUT (send to member). A payout ABOVE the operator's per-
 * transaction ceiling is split into ≤ceiling transfers that sum to `amount`
 * (an account can't receive more than the ceiling in one go — see config
 * splitForPayout); a normal payout is a single transfer. Returns:
 *   { status, transfers:[{payoutId, amount, status, failureReason?}], simulated }
 * where the parent-level `status` the caller records as Transaction.status is:
 *   REJECTED  — every transfer bounced at initiation (nothing reached PawaPay;
 *               record failed, fully retryable)
 *   COMPLETED — simulated (all transfers complete immediately)
 *   ACCEPTED  — ≥1 transfer accepted; the parent settles when they all COMPLETE
 *               via the webhook/cron reconciliation (see settlement service).
 */
export async function initiatePayout({
  amount,
  phone,
  provider,
  statementDescription = "Chuma payout",
  metadata = [],
}) {
  const correspondent = provider || providerFromPhone(phone);
  const msisdn = toMsisdn(phone);
  const chunks = config.pricing.splitForPayout(amount, correspondent);

  const transfers = [];
  for (const chunkAmount of chunks) {
    transfers.push(
      await sendOneTransfer({ amount: chunkAmount, msisdn, correspondent, statementDescription, metadata })
    );
  }

  const simulated = !ENABLED();
  const allRejected = transfers.every((t) => t.status === "REJECTED");
  const status = allRejected ? "REJECTED" : simulated ? "COMPLETED" : "ACCEPTED";
  return { status, transfers, simulated };
}

/**
 * Re-send specific transfer amounts (used by retry-payout for the non-COMPLETED
 * chunks of a partially-failed payout — already ≤ceiling, so NOT re-split).
 * Returns fresh transfer records (in the same order as `amounts`) to swap into
 * the parent's pawapay.transfers, plus `simulated`.
 */
export async function resendTransfers({
  amounts,
  phone,
  provider,
  statementDescription = "Chuma payout",
  metadata = [],
}) {
  const correspondent = provider || providerFromPhone(phone);
  const msisdn = toMsisdn(phone);
  const transfers = [];
  for (const amount of amounts) {
    transfers.push(
      await sendOneTransfer({ amount, msisdn, correspondent, statementDescription, metadata })
    );
  }
  return { transfers, simulated: !ENABLED() };
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
  resendTransfers,
  checkDepositStatus,
  checkPayoutStatus,
  predictProvider,
  providerFromPhone,
  toMsisdn,
};
