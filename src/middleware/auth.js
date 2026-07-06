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
 * Identity verification is mandatory before any money/group action — an
 * unverified or rejected user is blocked here even if a modified client tries
 * to bypass the onboarding gate. Returns 403 with a machine-readable code so
 * the app can route the user back to the verification screen.
 */
export function requireKyc(req, res, next) {
  if (req.user?.kyc?.status === "verified") return next();
  return res.status(403).json({
    error: "Identity verification required",
    code: "needs_kyc",
    kycStatus: req.user?.kyc?.status || "incomplete",
  });
}

export default { signToken, requireAuth, requireKyc };
