import crypto from "crypto";
import axios from "axios";
import config from "../config/index.js";

/**
 * Didit.me identity verification (KYC).
 *
 * The app never calls Didit directly — this service is the ONLY place the Didit
 * API key is used. It creates hosted verification sessions, reads decisions, and
 * verifies webhook signatures. See ../../.. frontend docs/didit-kyc.md.
 *
 * ⚠️ Targets Didit API v2. Confirm exact endpoint + field names against the
 * current Didit docs before go-live; the mappers below are deliberately
 * defensive about field-name variants.
 */

// Didit's decision `status` strings → the app's KycStatus vocabulary.
const STATUS_MAP = {
  approved: "approved",
  declined: "declined",
  "in review": "in_review",
  "in progress": "pending",
  "not started": "not_started",
  abandoned: "abandoned",
  expired: "expired",
  "kyc expired": "expired",
};

export function normalizeStatus(raw) {
  if (!raw) return "pending";
  return STATUS_MAP[String(raw).trim().toLowerCase()] || "pending";
}

// Map an app KycStatus onto the User.kyc.status enum.
export function modelStatusFor(status) {
  if (status === "approved") return "verified";
  if (status === "declined") return "rejected";
  if (status === "expired" || status === "abandoned") return "incomplete";
  return "pending";
}

function client() {
  return axios.create({
    baseURL: config.didit.baseUrl,
    headers: {
      "x-api-key": config.didit.apiKey,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
}

/** Create a Didit verification session. Returns { sessionId, url }. */
export async function createSession({ userId, returnUrl }) {
  const { data } = await client().post("/v2/session/", {
    workflow_id: config.didit.workflowId,
    vendor_data: String(userId), // maps the webhook back to this user
    callback: returnUrl,
  });
  const sessionId = data.session_id || data.id;
  const url = data.url || data.verification_url;
  if (!sessionId || !url)
    throw new Error("Didit session response missing session_id/url");
  return { sessionId, url };
}

/** Fetch the raw decision object for a session. */
export async function retrieveDecision(sessionId) {
  const { data } = await client().get(
    `/v2/session/${encodeURIComponent(sessionId)}/decision/`
  );
  return data;
}

/** Pull a verified identity out of a Didit decision, defensively. */
export function extractIdentity(decision) {
  if (!decision || typeof decision !== "object") return null;
  const src =
    decision.id_verification || decision.document || decision.kyc || decision;

  const firstName = src.first_name || src.firstName || "";
  const lastName = src.last_name || src.lastName || "";
  const fullName =
    src.full_name ||
    src.fullName ||
    [firstName, lastName].filter(Boolean).join(" ") ||
    "";

  return {
    firstName: firstName || (fullName ? fullName.split(/\s+/)[0] : ""),
    lastName,
    fullName,
    dateOfBirth: src.date_of_birth || src.dateOfBirth || "",
    documentNumber: src.document_number || src.documentNumber || "",
    documentType: src.document_type || src.documentType || "",
  };
}

/**
 * Normalize a decision (from the decision endpoint OR a webhook body) into
 * { status, verified }. `verified` is only populated when approved.
 */
export function summarizeDecision(payload) {
  const status = normalizeStatus(payload?.status);
  const verified =
    status === "approved"
      ? extractIdentity(payload?.decision || payload)
      : undefined;
  return { status, verified };
}

/**
 * Persist a verified identity onto a user doc. The app identifies members by a
 * single display name, so the verified FIRST NAME becomes `user.name`.
 * Returns the save() promise. Idempotent.
 */
export function applyVerifiedIdentity(user, verified) {
  const firstName =
    verified.firstName ||
    (verified.fullName ? verified.fullName.split(/\s+/)[0] : "");
  const existing = user.kyc ? user.kyc.toObject?.() ?? user.kyc : {};
  user.kyc = {
    ...existing,
    provider: existing.provider || "didit",
    status: "verified",
    firstName,
    fullName: verified.fullName || firstName,
    dateOfBirth: verified.dateOfBirth
      ? new Date(verified.dateOfBirth)
      : existing.dateOfBirth,
    documentNumber: verified.documentNumber || existing.documentNumber,
    documentType: verified.documentType || existing.documentType,
    decisionAt: new Date(),
  };
  if (firstName) user.name = firstName;
  return user.save();
}

/**
 * Verify a Didit webhook signature: HMAC-SHA256 (hex) of the raw request body
 * using the webhook secret, delivered in the `x-signature` header. Timing-safe.
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!config.didit.webhookSecret || !rawBody || !signatureHeader) return false;
  const expected = crypto
    .createHmac("sha256", config.didit.webhookSecret)
    .update(rawBody)
    .digest("hex");
  let a, b;
  try {
    a = Buffer.from(String(signatureHeader), "hex");
    b = Buffer.from(expected, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export default {
  normalizeStatus,
  modelStatusFor,
  createSession,
  retrieveDecision,
  extractIdentity,
  summarizeDecision,
  applyVerifiedIdentity,
  verifyWebhookSignature,
};
