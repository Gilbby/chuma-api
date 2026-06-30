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

router.post(
  "/pawapay/deposit",
  express.json(),
  asyncHandler(async (req, res) => {
    const { depositId, status, failureReason } = req.body || {};
    console.log(`[WEBHOOK] deposit ${depositId} → ${status}`);

    if (depositId) {
      const txn = await Transaction.findOne({ "pawapay.depositId": depositId });
      if (txn) {
        txn.pawapay.status = status;
        if (failureReason) txn.pawapay.failureReason = JSON.stringify(failureReason);
        txn.status =
          status === "COMPLETED"
            ? "completed"
            : status === "FAILED"
            ? "failed"
            : txn.status;
        await txn.save();
      }
    }
    res.status(200).json({ received: true });
  })
);

router.post(
  "/pawapay/payout",
  express.json(),
  asyncHandler(async (req, res) => {
    const { payoutId, status, failureReason } = req.body || {};
    console.log(`[WEBHOOK] payout ${payoutId} → ${status}`);

    if (payoutId) {
      const txn = await Transaction.findOne({ "pawapay.payoutId": payoutId });
      if (txn) {
        txn.pawapay.status = status;
        if (failureReason) txn.pawapay.failureReason = JSON.stringify(failureReason);
        txn.status =
          status === "COMPLETED"
            ? "completed"
            : status === "FAILED"
            ? "failed"
            : txn.status;
        await txn.save();
      }
    }
    res.status(200).json({ received: true });
  })
);

export default router;
