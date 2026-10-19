import express from "express";
import { joinPageLimiter } from "../middleware/rateLimits.js";
import config from "../config/index.js";

const router = express.Router();

/**
 * GET /join/:code - a join link tapped on a phone WITHOUT Chuma installed.
 * With the app installed, Android opens the app straight away (App Links,
 * verified by /.well-known/assetlinks.json) and this route is never reached.
 * Without it there is nothing to show, so send them to the Play Store to get
 * the app; once installed, tapping the link again opens it in the app.
 */
router.get("/:code", joinPageLimiter, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.redirect(302, config.links.playStoreUrl);
});

export default router;
