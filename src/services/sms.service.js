import AfricasTalking from "africastalking";
import config from "../config/index.js";

/**
 * AfricasTalking SMS service.
 *
 * When SMS_ENABLED=true and credentials are present, sends real SMS.
 * When SMS_ENABLED=false (default dev mode), logs the message to console
 * instead — so OTP and notifications work locally without spending credit.
 *
 * Sandbox testing:
 *   - Set AT_USERNAME=sandbox and AT_API_KEY to your sandbox key
 *   - Use the AT simulator (https://simulator.africastalking.com) to receive
 *   - Leave AT_SENDER_ID blank in sandbox
 *
 * Production:
 *   - Set AT_USERNAME to your live username, AT_API_KEY to live key
 *   - Register AT_SENDER_ID (e.g. CHUMA) and set it here
 *   - Set SMS_ENABLED=true
 */

let smsClient = null;

function getClient() {
  if (smsClient) return smsClient;
  if (!config.africasTalking.apiKey) return null;
  const at = AfricasTalking({
    apiKey: config.africasTalking.apiKey,
    username: config.africasTalking.username,
  });
  smsClient = at.SMS;
  return smsClient;
}

/**
 * Send an SMS to one or more recipients.
 * @param {string|string[]} to  International format, e.g. +260977234567
 * @param {string} message
 * @returns {Promise<{ sent: boolean, simulated?: boolean, raw?: any }>}
 */
export async function sendSms(to, message) {
  const recipients = Array.isArray(to) ? to : [to];

  if (!config.africasTalking.smsEnabled) {
    console.log(
      `\n[SMS SIMULATED] → ${recipients.join(", ")}\n  ${message}\n`
    );
    return { sent: true, simulated: true };
  }

  const client = getClient();
  if (!client) {
    console.warn("[SMS] AT_API_KEY missing — cannot send. Logging instead.");
    console.log(`[SMS FALLBACK] → ${recipients.join(", ")}: ${message}`);
    return { sent: false, simulated: true };
  }

  const options = {
    to: recipients,
    message,
  };
  // Only attach sender ID if configured (sandbox often has none)
  if (config.africasTalking.senderId) {
    options.from = config.africasTalking.senderId;
  }

  try {
    const raw = await client.send(options);
    return { sent: true, raw };
  } catch (err) {
    console.error("[SMS] send error:", err?.message || err);
    return { sent: false, error: err?.message };
  }
}

/**
 * Convenience: send an OTP code.
 */
export async function sendOtpSms(phone, code) {
  return sendSms(
    phone,
    `Your Chuma verification code is ${code}. It expires in ${config.otp.expiryMinutes} minutes. Do not share it.`
  );
}

export default { sendSms, sendOtpSms };
