import express from "express";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { Otp } from "../models/Otp.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth, signToken } from "../middleware/auth.js";
import {
  generateOtp,
  hashValue,
  normalizePhone,
} from "../utils/helpers.js";
import { sendOtpSms } from "../services/sms.service.js";
import { getTrustScore, getTrustBand } from "../services/logic.service.js";
import config from "../config/index.js";

const router = express.Router();

/**
 * POST /api/auth/request-otp
 * Body: { phone, mode: "signup" | "signin" }
 * Sends an OTP via AfricasTalking (or logs it in dev).
 */
router.post(
  "/request-otp",
  asyncHandler(async (req, res) => {
    const { phone, mode = "signup" } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone required" });

    const normalized = normalizePhone(phone);
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
      // In dev (SMS disabled) we return the code so you can test without SMS.
      ...(result.simulated ? { devCode: code } : {}),
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
    if (!phone || !code)
      return res.status(400).json({ error: "Phone and code required" });

    const normalized = normalizePhone(phone);
    const otp = await Otp.findOne({
      phone: normalized,
      purpose: mode,
      consumed: false,
    }).sort({ createdAt: -1 });

    if (!otp) return res.status(400).json({ error: "No OTP found, request again" });
    if (otp.expiresAt < new Date())
      return res.status(400).json({ error: "OTP expired" });
    if (otp.codeHash !== hashValue(code))
      return res.status(400).json({ error: "Incorrect code" });

    otp.consumed = true;
    await otp.save();

    let user = await User.findOne({ phone: normalized });

    if (mode === "signin") {
      if (!user)
        return res
          .status(404)
          .json({ error: "No account for this number. Please sign up." });
      return res.json({
        token: signToken(user._id),
        user: sanitizeUser(user),
        next: "tabs",
      });
    }

    // signup: create a stub user if not present, return token to finish setup
    if (!user) {
      user = await User.create({ name: "New member", phone: normalized });
    }
    res.json({
      token: signToken(user._id),
      user: sanitizeUser(user),
      next: "kyc",
    });
  })
);

/**
 * POST /api/auth/kyc  (auth)
 * Body: { nrcNumber, fullName, dateOfBirth, photoUrl? }
 */
router.post(
  "/kyc",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { nrcNumber, fullName, dateOfBirth, photoUrl } = req.body;
    req.user.kyc = {
      nrcNumber,
      fullName,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
      photoUrl,
      status: config.kyc.enabled ? "pending" : "pending",
    };
    if (fullName) req.user.name = fullName;
    await req.user.save();
    res.json({ message: "KYC saved", kyc: req.user.kyc, next: "pin" });
  })
);

/**
 * POST /api/auth/pin  (auth)
 * Body: { pin }
 * Sets the app PIN.
 */
router.post(
  "/pin",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { pin } = req.body;
    if (!pin || String(pin).length < 4)
      return res.status(400).json({ error: "PIN must be at least 4 digits" });
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
