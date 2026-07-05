import rateLimit from "express-rate-limit";

/**
 * Rate limiters — the API's abuse and cost-control layer.
 *
 * Two kinds of keys:
 *  - Per-IP (unauthenticated surface). Zambian carriers CGNAT heavily, so many
 *    legitimate users share one public IP — per-IP caps are set high enough
 *    that a busy carrier NAT never throttles real users, while still stopping
 *    a single machine from hammering the API.
 *  - Per-user (authenticated surface). Keyed on req.userId, so they must be
 *    mounted AFTER requireAuth. These protect the expensive actions: PawaPay
 *    initiations (each creates a pending Transaction the reconciliation cron
 *    then polls) and SMS sends (each costs AfricasTalking credit).
 *
 * The store is in-memory: counters reset on deploy/restart and are per
 * instance. Fine for a single instance; if the API is ever scaled out, move
 * to a shared store (rate-limit-redis).
 */

/** Global backstop for all /api routes. Generous — CGNAT-safe — but stops
 *  runaway clients and scripted hammering. Webhooks are exempt: PawaPay
 *  callbacks come from few IPs in bursts and are signature-verified. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.originalUrl.startsWith("/api/webhooks"),
  message: { error: "Too many requests, slow down and try again shortly" },
});

/** OTP sends cost SMS credit. The hard cost guard is per-phone (3/hour, in
 *  auth.routes.js); this per-IP cap only bounds single-source farming. */
export const otpRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many OTP requests, try again later" },
});

/** OTP guesses are already capped at 5 per code; this bounds bulk guessing
 *  across many phone numbers from one source. */
export const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later" },
});

/** Money-movement initiations (PawaPay deposits/payouts), per user. Each call
 *  hits PawaPay and creates a pending Transaction that the reconciliation
 *  cron polls every 5 minutes until final — so spam here multiplies into
 *  ongoing API traffic. 15 per 15 min is far above any honest usage. */
export const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.userId),
  message: {
    error: "Too many payment attempts. Please wait a few minutes and try again.",
  },
});

/** Group invites send an SMS each — per-user cap keeps an admin (or a stolen
 *  admin session) from draining SMS credit. */
export const inviteLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.userId),
  message: { error: "Too many invites this hour. Try again later." },
});

export default {
  apiLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  paymentLimiter,
  inviteLimiter,
};
