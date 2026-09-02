import jwt from "jsonwebtoken";
import config from "../config/index.js";
import { User } from "../models/User.js";

export function signToken(userId) {
  return jwt.sign({ uid: userId }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}

/**
 * Require a valid JWT. Attaches req.user (the User doc) and req.userId.
 */
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const payload = jwt.verify(token, config.jwt.secret);
    const user = await User.findById(payload.uid);
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }
    req.user = user;
    req.userId = user._id;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Require a KYC-verified user. Must run AFTER requireAuth (reads req.user).
 * Reserved for CHAIRPERSON-level actions — founding a group and distributing a
 * share-out. Ordinary members transact under requireRealName instead: share-out
 * and loan payouts are addressed by mobile-money number, not by verified name.
 * Returns 403 with a machine-readable code so the app can route to the
 * verification screen instead of showing a raw error.
 */
export function requireKyc(req, res, next) {
  if (req.user?.kyc?.status === "verified") return next();
  return res.status(403).json({
    error: "Identity verification required",
    code: "needs_kyc",
    kycStatus: req.user?.kyc?.status || "incomplete",
  });
}

/** A display name the user actually chose — not the signup stub or a phone. */
export function hasRealName(name) {
  const trimmed = String(name || "").trim();
  if (trimmed.length < 2) return false;
  if (trimmed.toLowerCase() === "new member") return false;
  // A phone number back-filled as a name (invites store the number as the
  // placeholder name until the invitee signs up).
  if (/^[-+0-9 ]+$/.test(trimmed)) return false;
  return true;
}

/**
 * Require a chosen display name. Must run AFTER requireAuth (reads req.user).
 * This is the member-tier gate: a payout or a group ledger entry is meaningless
 * if it reads "New member". Full KYC stays on the chairperson routes.
 */
export function requireRealName(req, res, next) {
  if (hasRealName(req.user?.name)) return next();
  return res.status(403).json({
    error: "Add your name before you can transact",
    code: "needs_name",
  });
}

export default { signToken, requireAuth, requireKyc, requireRealName, hasRealName };
