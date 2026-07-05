import express from "express";
import { Transaction } from "../models/Transaction.js";
import { asyncHandler } from "../middleware/error.js";
import { verifyPawaPayCallbackMiddleware } from "../middleware/pawapaySignature.js";
import {
  settleCompletedTransaction,
  handleFailedTransaction,
} from "../services/settlement.service.js";

const router = express.Router();

/**
 * PawaPay sends the FINAL status of deposits/payouts here.
 *
 * Callback URLs are configured ONLY in the PawaPay Dashboard (per environment,
 * under Callback URLs) — the API has no per-request callback field in v1 or v2,
 * and the PAWAPAY_*_CALLBACK_URL .env vars are informational, not sent anywhere.
 * Point the Dashboard at:
 *   https://<public-base>/api/webhooks/pawapay/deposit
 *   https://<public-base>/api/webhooks/pawapay/payout
 *
 * To re-test delivery against an existing transaction:
 *   POST {PAWAPAY_BASE_URL}/deposits/resend-callback {"depositId": "..."}
 *   POST {PAWAPAY_BASE_URL}/payouts/resend-callback  {"payoutId": "..."}
 *
 * Status values: COMPLETED | FAILED. Always respond 200 quickly.
 */

// RFC-9421 signature verification is implemented in
// src/middleware/pawapaySignature.js and gated by PAWAPAY_VERIFY_CALLBACKS
// (on by default whenever PAYMENTS_ENABLED=true; off for dev/Postman).
// The pending→final atomic transition below stays as defense-in-depth: even a
// replayed *valid* callback only ever transitions a still-pending transaction,
// so it remains a no-op.

const FINAL_STATUSES = ["COMPLETED", "FAILED"];

async function applyFinalStatus(idField, id, status, failureReason) {
  if (!id || typeof id !== "string") return "ignored";
  if (!FINAL_STATUSES.includes(status)) return "ignored";

  const update = {
    status: status === "COMPLETED" ? "completed" : "failed",
    "pawapay.status": status,
    ...(failureReason
      ? { "pawapay.failureReason": JSON.stringify(failureReason) }
      : {}),
  };
  // Atomic: only a still-pending transaction can transition (idempotent)
  const txn = await Transaction.findOneAndUpdate(
    { [idField]: id, status: "pending" },
    update,
    { new: true }
  );
  if (!txn) return "no-op";

  // We won the pending→final flip, so we apply the settlement effects exactly
  // once. Never let a settlement error fail the callback response — PawaPay
  // retries would no-op on the flip and the effects would be lost silently;
  // log loudly for manual repair instead.
  try {
    if (status === "COMPLETED") await settleCompletedTransaction(txn);
    else await handleFailedTransaction(txn);
  } catch (err) {
    console.error(
      `[SETTLEMENT] FAILED to apply effects for txn ${txn._id} (${txn.type}, ${status}):`,
      err
    );
  }
  return "applied";
}

router.post(
  "/pawapay/deposit",
  verifyPawaPayCallbackMiddleware(),
  express.json(),
  asyncHandler(async (req, res) => {
    const { depositId, status, failureReason } = req.body || {};
    const result = await applyFinalStatus(
      "pawapay.depositId",
      depositId,
      status,
      failureReason
    );
    console.log(`[WEBHOOK] deposit ${depositId} → ${status} (${result})`);
    res.status(200).json({ received: true });
  })
);

router.post(
  "/pawapay/payout",
  verifyPawaPayCallbackMiddleware(),
  express.json(),
  asyncHandler(async (req, res) => {
    const { payoutId, status, failureReason } = req.body || {};
    const result = await applyFinalStatus(
      "pawapay.payoutId",
      payoutId,
      status,
      failureReason
    );
    console.log(`[WEBHOOK] payout ${payoutId} → ${status} (${result})`);
    res.status(200).json({ received: true });
  })
);

export default router;
