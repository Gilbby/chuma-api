import express from "express";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { paymentLimiter } from "../middleware/rateLimits.js";
import {
  planSummary,
  syncUserPlan,
  playBillingEnabled,
  preferGroup,
} from "../services/billing.service.js";

const router = express.Router();

/**
 * GET /api/billing/plan (auth) - the caller's Chuma Plan and which of the
 * groups they founded it covers. `enabled: false` means billing is off (free
 * tracker build) and the app should show no plan UI at all.
 */
router.get(
  "/plan",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await planSummary(req.userId));
  })
);

/**
 * POST /api/billing/sync (auth) - called by the app right after a purchase,
 * plan change or restore. Re-reads the subscription from RevenueCat (never
 * from the request body) and re-applies coverage, so a just-bought plan unlocks
 * groups without waiting for the webhook.
 */
router.post(
  "/sync",
  requireAuth,
  paymentLimiter,
  asyncHandler(async (req, res) => {
    if (!playBillingEnabled())
      return res.json(await planSummary(req.userId));
    try {
      await syncUserPlan(req.userId);
    } catch (e) {
      return res
        .status(e.status || 502)
        .json({ error: "Couldn't confirm your plan with Google Play yet. Try again in a moment." });
    }
    res.json(await planSummary(req.userId));
  })
);

/**
 * POST /api/billing/prefer (auth) { groupId } - the founder picks a group to be
 * covered by their plan first ("move my plan to this group", or after buying
 * from that group's screen). Only works for groups they founded.
 */
router.post(
  "/prefer",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!playBillingEnabled()) return res.json(await planSummary(req.userId));
    const ok = await preferGroup(req.userId, req.body?.groupId);
    if (!ok)
      return res
        .status(404)
        .json({ error: "Only the group's founder can put their plan on it." });
    res.json(await planSummary(req.userId));
  })
);

export default router;
