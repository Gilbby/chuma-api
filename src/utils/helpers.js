import crypto from "crypto";

/** Generate a numeric OTP of given length (crypto-secure). */
export function generateOtp(length = 6) {
  let code = "";
  for (let i = 0; i < length; i++) {
    code += crypto.randomInt(0, 10);
  }
  return code;
}

/** Hash a value (OTP or PIN) for storage. */
export function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a, b) {
  const ba = Buffer.from(String(a), "hex");
  const bb = Buffer.from(String(b), "hex");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Generate a 6-character uppercase invite code (crypto-secure). */
export function generateInviteCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return code;
}

/** Generate a Chuma receipt id, e.g. CHM-8F3K2Q9D (collision-resistant). */
export function generateReceiptId(prefix = "CHM") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[crypto.randomInt(0, chars.length)];
  }
  return `${prefix}-${id}`;
}

/** Detect Zambian mobile money network from a phone number. */
export function detectNetwork(phone) {
  const digits = String(phone).replace(/\D/g, "");
  const core = digits.startsWith("260") ? digits.slice(3) : digits.replace(/^0/, "");
  const prefix = core.slice(0, 2);
  if (prefix === "76" || prefix === "96")
    return { network: "MTN MoMo", color: "#FFCC00" };
  if (prefix === "77" || prefix === "97")
    return { network: "Airtel Money", color: "#ED1C24" };
  if (prefix === "75" || prefix === "95")
    return { network: "Zamtel Kwacha", color: "#009639" };
  return { network: "Unknown", color: "#9CA3AF" };
}

/** Normalise a Zambian phone to +260XXXXXXXXX. */
export function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("260")) return "+" + digits;
  if (digits.startsWith("0")) return "+260" + digits.slice(1);
  if (digits.length === 9) return "+260" + digits;
  return "+" + digits;
}

export default {
  generateOtp,
  hashValue,
  safeEqualHex,
  generateInviteCode,
  generateReceiptId,
  detectNetwork,
  normalizePhone,
};
