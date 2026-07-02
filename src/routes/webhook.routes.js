import express from "express";
import { Transaction } from "../models/Transaction.js";
import { asyncHandler } from "../middleware/error.js";

const router = express.Router();

/**
 * PawaPay sends the FINAL status of deposits/payouts here.
 * Configure these URLs (your ngrok https URL + these paths) in your .env:
 *   PAWAPAY_DEPOSIT_CALLBACK_URL = https://<ngrok>/api/webhooks/pawapay/deposit
 *   PAWAPAY_PAYOUT_CALLBACK_URL  = https://<ngrok>/api/webhooks/pawapay/payout
 *
 * Status values: COMPLETED | FAILED. Always respond 200 quickly.
 *
 * NOTE: For production, verify the request signature (RFC-9421) using your
 * public key configured in the PawaPay dashboard before trusting the payload.
 * That verification is left as a clearly-marked TODO.
 */

// TODO: implement RFC-9421 signature verification for signed callbacks.
// Until then the handlers below are defensive: they accept only known final
// statuses and only transition transactions that are still pending, so a
// replayed or spoofed callback can never flip a settled transaction.

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
  return txn ? "applied" : "no-op";
}

router.post(
  "/pawapay/deposit",
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
