import express from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { Otp } from "../models/Otp.js";
import { Group } from "../models/Group.js";
import { Loan } from "../models/Loan.js";
import { Notification } from "../models/Notification.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth, signToken, hasRealName } from "../middleware/auth.js";
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

// App-store reviewer demo login (see config.review). Precomputed once so the
// hot OTP path stays a cheap string compare. The bypass is active only when
// BOTH a review phone and code are configured; otherwise it is fully inert and
// the number behaves like any other.
const REVIEW_PHONE = config.review.phone ? normalizePhone(config.review.phone) : "";
const REVIEW_CODE = config.review.code || "";
const REVIEW_ENABLED = !!REVIEW_PHONE && !!REVIEW_CODE;
const isReviewPhone = (normalizedPhone) =>
  REVIEW_ENABLED && normalizedPhone === REVIEW_PHONE;

const OTP_MODES = ["signup", "signin"];
const MAX_OTP_ATTEMPTS = 5;
const MAX_OTPS_PER_PHONE_PER_HOUR = 3;
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;

// Failed PIN attempts per user, in memory: a lockout only has to outlive a
// guessing burst, and nothing here is worth a database write per attempt. A
// process restart forgives the counter — an acceptable trade for a check that
// already sits behind a valid session token.
const pinAttempts = new Map();

function pinAttemptsExceeded(userId) {
  const entry = pinAttempts.get(userId);
  if (!entry) return false;
  if (Date.now() - entry.first > PIN_LOCKOUT_MS) {
    pinAttempts.delete(userId);
    return false;
  }
  return entry.count >= MAX_PIN_ATTEMPTS;
}

function recordFailedPin(userId) {
  const now = Date.now();
  const entry = pinAttempts.get(userId);
  if (!entry || now - entry.first > PIN_LOCKOUT_MS) {
    pinAttempts.set(userId, { count: 1, first: now });
    return MAX_PIN_ATTEMPTS - 1;
  }
  entry.count += 1;
  return Math.max(0, MAX_PIN_ATTEMPTS - entry.count);
}

function clearPinAttempts(userId) {
  pinAttempts.delete(userId);
}

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

    // Reviewer demo number: skip SMS, throttle and stored OTP entirely — the
    // fixed code is accepted directly in verify-otp. Return success so the app
    // advances to the code screen exactly as it would for a real number.
    if (isReviewPhone(normalized)) {
      return res.json({ message: "OTP sent", phone: normalized });
    }

    // Signup is only for new numbers. If a fully set-up account (has a PIN)
    // already exists, don't start the create-account flow — send them to sign in.
    // Seeded/invited stubs (no PIN yet) are allowed to claim their number.
    if (mode === "signup") {
      const existing = await User.findOne({ phone: normalized });
      if (existing?.pinHash)
        return res.status(409).json({
          error: "An account already exists for this number. Please sign in instead.",
        });
    }

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

    // Reviewer demo login: the fixed code signs in a persistent demo account
    // without touching the OTP store. The account is created once (KYC marked
    // verified so the reviewer can explore group creation without Didit) and
    // reused thereafter, landing straight in the app.
    if (isReviewPhone(normalized)) {
      if (String(code) !== REVIEW_CODE) {
        return res.status(400).json({ error: "Incorrect code" });
      }
      let reviewer = await User.findOne({ phone: normalized });
      if (!reviewer) {
        reviewer = await User.create({
          name: "App Reviewer",
          phone: normalized,
          kyc: {
            provider: "review",
            status: "verified",
            firstName: "App",
            fullName: "App Reviewer",
            decisionAt: new Date(),
          },
        });
      }
      return res.json({
        token: signToken(reviewer._id),
        user: sanitizeUser(reviewer),
        next: hasRealName(reviewer.name) ? "tabs" : "name",
      });
    }

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
      // Routing: everyone lands in the app. KYC is asked for at exactly one
      // point — founding a group (POST /groups), where the founder becomes its
      // Chairperson. Nobody is nudged for it here: Members, and the Treasurer
      // and Secretary who are invited into their roles, never need it — they
      // transact under requireRealName. Clear any nudge an older build left.
      await clearKycNudge(user._id);
      return res.json({
        token: signToken(user._id),
        user: sanitizeUser(user),
        // Accounts created before the name step exists still carry the signup
        // stub. Ask once, on the way in — the same step, just late.
        next: hasRealName(user.name) ? "tabs" : "name",
      });
    }

    // signup: create a stub user if not present, return token to finish setup.
    // Guard (defense in depth — request-otp already blocks this): a completed
    // account (has a PIN) can't be re-created via signup; route them to sign in.
    if (user?.pinHash)
      return res.status(409).json({
        error: "An account already exists for this number. Please sign in instead.",
      });
    if (!user) {
      user = await User.create({
        name: "New member",
        phone: normalized,
        kyc: { status: "incomplete" },
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
    res.json({
      token: signToken(user._id),
      user: sanitizeUser(user),
      next: "name",
    });
  })
);

// Merge new fields onto the user's kyc subdocument without dropping existing ones.
function mergeKyc(user, patch) {
  const existing = user.kyc ? user.kyc.toObject?.() ?? user.kyc : {};
  user.kyc = { ...existing, ...patch };
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
 * POST /api/auth/verify-pin  (auth)
 * Body: { pin }
 * Checks the app PIN without changing it — the client uses it to unlock
 * sensitive views (revealing a balance, confirming money actions). Kept
 * separate from POST /pin on purpose: verifying must never re-hash the PIN,
 * and it must not honour the post-OTP reset window, which would let a fresh
 * sign-in skip the check entirely.
 */
router.post(
  "/verify-pin",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { pin } = req.body;
    if (!req.user.pinHash)
      return res
        .status(400)
        .json({ error: "No PIN set for this account", code: "no_pin" });

    const userId = String(req.user._id);
    if (pinAttemptsExceeded(userId))
      return res.status(429).json({
        error: "Too many incorrect PIN attempts. Try again in a few minutes.",
        code: "pin_locked",
      });

    const valid =
      /^\d{4,6}$/.test(String(pin ?? "")) &&
      (await bcrypt.compare(String(pin), req.user.pinHash));

    if (!valid) {
      const remaining = recordFailedPin(userId);
      return res
        .status(401)
        .json({ error: "Incorrect PIN", code: "bad_pin", remaining });
    }

    clearPinAttempts(userId);
    res.json({ valid: true });
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
    // A KYC-verified name is taken from the identity document, so it is fixed.
    // Members who never verified may rename themselves freely.
    if (name && name !== req.user.name) {
      if (req.user.kyc?.status === "verified")
        return res.status(403).json({
          error: "Your verified name comes from your ID and can't be changed.",
          code: "name_locked",
        });
      if (!hasRealName(name))
        return res.status(400).json({ error: "Enter your real name" });
      req.user.name = name;
    }
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

/**
 * DELETE /api/auth/account  (auth)
 *
 * Permanent account deletion — required by the Google Play "Data deletion" and
 * Apple 5.1.1(v) policies for any app that lets you create an account. This is
 * the in-app path; a public web request form should point at the same outcome.
 *
 * Money first: an account can't be deleted while it still holds savings, owes a
 * loan, or is the sole chairperson keeping a live group running — deleting then
 * would strand a member's money or leave a group headless. Those cases return
 * 409 { code: "has_obligations", blockers } so the app can tell the user exactly
 * what to settle. Both stores permit gating deletion on this, provided the
 * reason is shown (it is).
 *
 * When nothing blocks it: personal data (the User doc — phone, KYC identity,
 * NRC/DOB, payment details — plus notifications and OTPs) is deleted, and the
 * user is severed from every group member row. Completed ledger entries
 * (Transaction/Loan) are retained for audit/records with only a name snapshot,
 * carrying no live link back to the deleted person.
 */
router.delete(
  "/account",
  requireAuth,
  asyncHandler(async (req, res) => {
    const userId = req.user._id;
    const blockers = [];

    // Outstanding loans anywhere → must be repaid (or cleared on group exit).
    const openLoans = await Loan.find({
      memberId: userId,
      status: { $in: ["active", "overdue"] },
    }).select("groupName outstanding");
    for (const l of openLoans) {
      blockers.push({
        type: "loan",
        groupName: l.groupName || "a group",
        message: `Outstanding loan of K${l.outstanding ?? 0} in ${l.groupName || "a group"}. Repay it first.`,
      });
    }

    // Live membership that still holds their money, or a chair others depend on.
    const groups = await Group.find({
      "members.userId": userId,
      status: { $ne: "closed" },
    });
    for (const g of groups) {
      const me = g.members.find(
        (m) => String(m.userId) === String(userId) && m.status !== "removed"
      );
      if (!me) continue;

      if ((me.savings || 0) > 0) {
        blockers.push({
          type: "savings",
          groupName: g.name,
          message: `K${me.savings} in savings still held in ${g.name}. Leave the group to be refunded first.`,
        });
      }

      const isChair =
        String(g.governance?.chairpersonUserId || "") === String(userId) ||
        me.role === "Chairperson";
      const otherActive = g.members.filter(
        (m) => String(m.userId) !== String(userId) && m.status === "active"
      ).length;
      if (isChair && otherActive > 0 && g.status !== "pending-payment") {
        blockers.push({
          type: "chair",
          groupName: g.name,
          message: `You are the chairperson of ${g.name}. Hand the role to another admin or close the group first.`,
        });
      }
    }

    if (blockers.length) {
      return res.status(409).json({
        error: "Settle your group obligations before deleting your account.",
        code: "has_obligations",
        blockers,
      });
    }

    // Cleared to delete. Drop unaccepted invites outright (just an unclaimed
    // phone + name), then sever the personal link on every remaining member row
    // — the name snapshot stays as history, the userId/phone do not.
    await Group.updateMany(
      { members: { $elemMatch: { userId, status: "pending" } } },
      { $pull: { members: { userId, status: "pending" } } }
    );
    await Group.updateMany(
      { "members.userId": userId },
      {
        $set: {
          "members.$[m].userId": null,
          "members.$[m].phone": null,
          "members.$[m].status": "removed",
        },
      },
      { arrayFilters: [{ "m.userId": userId }] }
    );
    // Don't leave a governance pointer to a person who no longer exists.
    await Group.updateMany(
      { "governance.chairpersonUserId": userId },
      { $set: { "governance.chairpersonUserId": null } }
    );

    await Notification.deleteMany({ userId });
    await Otp.deleteMany({ phone: req.user.phone });
    await User.deleteOne({ _id: userId });

    res.json({ message: "Account deleted" });
  })
);

function sanitizeUser(user) {
  const score = getTrustScore(
    { contributions: 0, loanActive: 0 },
    0
  ); // recomputed properly in reports; cached here
  const obj = user.toObject();
  // hasPin, never the hash: the client offers the PIN unlock only when there
  // is a PIN to check against.
  const hasPin = !!obj.pinHash;
  delete obj.pinHash;
  return { ...obj, hasPin, trustBand: getTrustBand(user.trustScore || score) };
}

export default router;
