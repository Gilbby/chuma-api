import express from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { Otp } from "../models/Otp.js";
import { Group } from "../models/Group.js";
import { Notification } from "../models/Notification.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import {
  generateOtp,
  hashValue,
  safeEqualHex,
  normalizePhone,
} from "../utils/helpers.js";
import { sendOtpSms } from "../services/sms.service.js";
import { getTrustScore, getTrustBand } from "../services/logic.service.js";
import {
  createSession as createDiditSession,
  retrieveDecision,
  summarizeDecision,
  applyVerifiedIdentity,
  modelStatusFor,
} from "../services/didit.service.js";
import config from "../config/index.js";

const router = express.Router();

const OTP_MODES = ["signup", "signin"];
const MAX_OTP_ATTEMPTS = 5;
const MAX_OTPS_PER_PHONE_PER_HOUR = 3;

/**
 * POST /api/auth/request-otp
 * Body: { phone, mode: "signup" | "signin" }
 * Sends an OTP via AfricasTalking (or logs it in dev).
 */
router.post(
  "/request-otp",
  asyncHandler(async (req, res) => {
    const { phone, mode = "signup" } = req.body;
    if (!phone || typeof phone !== "string")
      return res.status(400).json({ error: "Phone required" });
    if (!OTP_MODES.includes(mode))
      return res.status(400).json({ error: "Invalid mode" });

    const normalized = normalizePhone(phone);

    // Per-phone throttle: SMS costs money and codes shouldn't be farmable
    const recent = await Otp.countDocuments({
      phone: normalized,
      createdAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
    });
    if (recent >= MAX_OTPS_PER_PHONE_PER_HOUR)
      return res
        .status(429)
        .json({ error: "Too many codes requested for this number. Try again later." });

    const code = generateOtp(config.otp.length);
    const expiresAt = new Date(
      Date.now() + config.otp.expiryMinutes * 60 * 1000
    );

    await Otp.create({
      phone: normalized,
      codeHash: hashValue(code),
      purpose: mode,
      expiresAt,
    });

    const result = await sendOtpSms(normalized, code);

    res.json({
      message: "OTP sent",
      phone: normalized,
      // Dev convenience only: never leak the code outside development,
      // even if SMS is accidentally disabled in production.
      ...(result.simulated && config.env === "development"
        ? { devCode: code }
        : {}),
    });
  })
);

/**
 * POST /api/auth/verify-otp
 * Body: { phone, code, mode }
 * Verifies OTP. For signin, returns a token. For signup, returns a short-lived
 * token so the client can complete KYC + PIN.
 */
router.post(
  "/verify-otp",
  asyncHandler(async (req, res) => {
    const { phone, code, mode = "signup" } = req.body;
    if (!phone || !code || typeof phone !== "string")
      return res.status(400).json({ error: "Phone and code required" });
    if (!OTP_MODES.includes(mode))
      return res.status(400).json({ error: "Invalid mode" });

    const normalized = normalizePhone(phone);
    const otp = await Otp.findOne({
      phone: normalized,
      purpose: mode,
      consumed: false,
    }).sort({ createdAt: -1 });

    if (!otp) return res.status(400).json({ error: "No OTP found, request again" });
    if (otp.expiresAt < new Date())
      return res.status(400).json({ error: "OTP expired" });
    if (otp.attempts >= MAX_OTP_ATTEMPTS)
      return res
        .status(400)
        .json({ error: "Too many wrong attempts. Request a new code." });
    if (!safeEqualHex(otp.codeHash, hashValue(code))) {
      otp.attempts += 1;
      await otp.save();
      return res.status(400).json({ error: "Incorrect code" });
    }

    otp.consumed = true;
    await otp.save();

    let user = await User.findOne({ phone: normalized });

    // Fresh OTP proves phone ownership → allow PIN (re)set for 10 minutes
    const pinResetAllowedUntil = new Date(Date.now() + 10 * 60 * 1000);

    if (mode === "signin") {
      if (!user)
        return res
          .status(404)
          .json({ error: "No account for this number. Please sign up." });
      user.pinResetAllowedUntil = pinResetAllowedUntil;
      await user.save();
      // Routing:
      //  - verified            → into the app
      //  - unverified + signup  → HARD gate: must finish KYC (onboardingRequired)
      //  - unverified + seeded  → soft: into the app with a standing verify nudge
      const verified = user.kyc?.status === "verified";
      if (!verified && user.kyc?.onboardingRequired) {
        return res.json({
          token: signToken(user._id),
          user: sanitizeUser(user),
          next: "kyc",
        });
      }
      if (!verified) await ensureKycNudge(user._id);
      return res.json({
        token: signToken(user._id),
        user: sanitizeUser(user),
        next: "tabs",
      });
    }

    // signup: create a stub user if not present, return token to finish setup.
    // onboardingRequired flags this as an app signup → KYC is mandatory before
    // entering the app (seeded/manually-added users have no flag = soft nudge).
    if (!user) {
      user = await User.create({
        name: "New member",
        phone: normalized,
        kyc: { status: "incomplete", onboardingRequired: true },
      });

      // Back-fill any phone-based invites so this new user sees pending
      // invitations in-app. Resilient: signup must still succeed if this fails.
      try {
        const invitingGroups = await Group.find({
          members: { $elemMatch: { phone: normalized, status: "pending" } },
        });
        for (const group of invitingGroups) {
          const member = group.members.find(
            (m) => m.phone === normalized && m.status === "pending"
          );
          if (member) {
            // Targeted positional $set of only this member's userId (status stays
            // "pending" — they still accept in-app). A full group.save() here would
            // persist read-time values and clobber a concurrent settlement $inc.
            await Group.updateOne(
              {
                _id: group._id,
                members: { $elemMatch: { phone: normalized, status: "pending" } },
              },
              { $set: { "members.$.userId": user._id } }
            );
          }
          await Notification.create({
            userId: user._id,
            type: "invite",
            title: "Group invitation",
            body: `${member.invitedByName || "Someone"} invited you to join ${group.name}.`,
            groupId: group._id,
            groupName: group.name,
            invitedBy: member.invitedByName || group.name,
          });
        }
      } catch (err) {
        console.error("Invite back-fill failed on signup:", err);
      }
    }
    user.pinResetAllowedUntil = pinResetAllowedUntil;
    await user.save();
    await ensureKycNudge(user._id);
    res.json({
      token: signToken(user._id),
      user: sanitizeUser(user),
      next: "kyc",
    });
  })
);

// Merge new fields onto the user's kyc subdocument without dropping existing ones.
function mergeKyc(user, patch) {
  const existing = user.kyc ? user.kyc.toObject?.() ?? user.kyc : {};
  user.kyc = { ...existing, ...patch };
}

// Ensure a single standing "complete your KYC" nudge sits in the user's inbox.
// Idempotent — never duplicates if one is already there. Best-effort: a nudge
// must never break authentication.
async function ensureKycNudge(userId) {
  try {
    const existing = await Notification.findOne({ userId, type: "kyc" });
    if (existing) return;
    await Notification.create({
      userId,
      type: "kyc",
      title: "Verify your identity",
      body: "Complete a quick identity check to secure your account and unlock sending and receiving money.",
    });
  } catch (err) {
    console.error("ensureKycNudge failed:", err.message);
  }
}

// Remove any standing KYC nudge once the user is verified.
async function clearKycNudge(userId) {
  try {
    await Notification.deleteMany({ userId, type: "kyc" });
  } catch (err) {
    console.error("clearKycNudge failed:", err.message);
  }
}

/**
 * POST /api/auth/kyc/session  (auth)
 * Body: { returnUrl }  → { sessionId, url }
 * Creates a Didit verification session. In simulated mode (DIDIT_ENABLED=false)
 * returns the app's own deep link so onboarding proceeds without Didit.
 */
router.post(
  "/kyc/session",
  requireAuth,
  asyncHandler(async (req, res) => {
    const returnUrl = req.body?.returnUrl;

    if (!config.didit.enabled) {
      const sessionId = `sim_${req.user._id}_${Date.now()}`;
      mergeKyc(req.user, { provider: "didit-sim", sessionId, status: "pending" });
      await req.user.save();
      return res.json({ sessionId, url: returnUrl || config.publicBaseUrl });
    }

    const { sessionId, url } = await createDiditSession({
      userId: req.user._id,
      returnUrl,
    });
    mergeKyc(req.user, { provider: "didit", sessionId, status: "pending" });
    await req.user.save();
    res.json({ sessionId, url });
  })
);

/**
 * GET /api/auth/kyc/status?sessionId=...  (auth)  → { status, verified? }
 * Returns the current Didit decision. On approval, sets the user's display name
 * to the verified first name (authoritative; the webhook does the same).
 */
router.get(
  "/kyc/status",
  requireAuth,
  asyncHandler(async (req, res) => {
    // Already resolved on this user → return the cached result.
    if (req.user.kyc?.status === "verified") {
      return res.json({
        status: "approved",
        verified: {
          firstName: req.user.kyc.firstName || req.user.name,
          fullName: req.user.kyc.fullName || req.user.name,
          dateOfBirth: req.user.kyc.dateOfBirth,
          documentNumber: req.user.kyc.documentNumber,
        },
      });
    }

    if (!config.didit.enabled) {
      // Simulated mode: auto-approve, keeping the user's existing name.
      const firstName = (req.user.name || "").split(/\s+/)[0] || req.user.name;
      mergeKyc(req.user, {
        provider: "didit-sim",
        status: "verified",
        firstName,
        fullName: req.user.name,
        decisionAt: new Date(),
      });
      await req.user.save();
      await clearKycNudge(req.user._id);
      return res.json({
        status: "approved",
        verified: { firstName, fullName: req.user.name },
      });
    }

    const sessionId = req.query.sessionId || req.user.kyc?.sessionId;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const decision = await retrieveDecision(String(sessionId));
    const { status, verified } = summarizeDecision(decision);

    if (status === "approved" && verified) {
      await applyVerifiedIdentity(req.user, verified);
      await clearKycNudge(req.user._id);
    } else {
      mergeKyc(req.user, { status: modelStatusFor(status) });
      await req.user.save();
    }
    res.json({ status, verified });
  })
);

/**
 * POST /api/auth/pin  (auth)
 * Body: { pin, currentPin? }
 * Sets the app PIN. Changing an existing PIN requires the current one, so a
 * stolen session token alone can't take over the PIN.
 */
router.post(
  "/pin",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { pin, currentPin } = req.body;
    if (!/^\d{4,6}$/.test(String(pin ?? "")))
      return res.status(400).json({ error: "PIN must be 4-6 digits" });

    if (req.user.pinHash) {
      const recentlyVerifiedOtp =
        req.user.pinResetAllowedUntil &&
        req.user.pinResetAllowedUntil > new Date();
      const ok =
        recentlyVerifiedOtp ||
        (currentPin != null &&
          (await bcrypt.compare(String(currentPin), req.user.pinHash)));
      if (!ok)
        return res
          .status(403)
          .json({ error: "Current PIN required to change your PIN" });
    }

    req.user.pinHash = await bcrypt.hash(String(pin), 10);
    await req.user.save();
    res.json({ message: "PIN set", next: "biometric" });
  })
);

/**
 * GET /api/auth/me  (auth)
 */
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ user: sanitizeUser(req.user) });
  })
);

/**
 * PATCH /api/auth/profile  (auth)
 * Body: { name?, avatar?, preferredPayment? }
 */
router.patch(
  "/profile",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, avatar, preferredPayment } = req.body;
    if (name) req.user.name = name;
    if (avatar) req.user.avatar = avatar;
    if (preferredPayment) {
      req.user.preferredPayment = {
        ...req.user.preferredPayment?.toObject?.(),
        ...preferredPayment,
      };
    }
    await req.user.save();
    res.json({ message: "Profile updated", user: sanitizeUser(req.user) });
  })
);

function sanitizeUser(user) {
  const score = getTrustScore(
    { contributions: 0, loanActive: 0 },
    0
  ); // recomputed properly in reports; cached here
  const obj = user.toObject();
  delete obj.pinHash;
  return { ...obj, trustBand: getTrustBand(user.trustScore || score) };
}

export default router;
