import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { sendSms } from "./sms.service.js";
import { normalizePhone } from "../utils/helpers.js";

/**
 * In-app notification plus an optional SMS, from one call.
 *
 * Every notify site already writes a Notification row, which the member sees
 * when they next open their inbox. That is enough for "your invite was
 * accepted" and useless for "hand over K500 in cash": the people who have to
 * act are exactly the ones not looking at the app. So money-moving and
 * time-limited events pass `sms: true` and go out over the network as well.
 *
 * SMS costs credit per recipient, so it is opt-in per call site rather than
 * blanket-on. A failed send never breaks the action that triggered it. The
 * Notification row is the source of truth and the SMS is only a nudge, so a
 * dead AfricasTalking key must not roll back a confirmed cash receipt.
 *
 * `smsText` is separate from `body` on purpose. The in-app body can run long
 * and lean on context the screen already shows; an SMS arrives alone and is
 * billed per 160 characters, so it repeats the group or amount and stops.
 */

/** Recipients' phone numbers, deduped, in the +260 format AT expects. */
async function phonesFor(userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return [];
  const users = await User.find({ _id: { $in: ids } })
    .select("phone")
    .lean();
  return [
    ...new Set(
      users
        .map((u) => u.phone)
        .filter(Boolean)
        // Stored numbers are already normalized; this is idempotent and keeps
        // an older row that predates normalization from being dropped.
        .map(normalizePhone)
    ),
  ];
}

async function smsBlast(userIds, text) {
  if (!text) return;
  try {
    const to = await phonesFor(userIds);
    if (to.length) await sendSms(to, text);
  } catch (err) {
    console.warn("[notify] SMS send failed:", err.message);
  }
}

/**
 * Notify one member.
 * @param {object} opts Notification fields, plus:
 *   @param {boolean} [opts.sms]     also send an SMS
 *   @param {string}  [opts.smsText] SMS wording; falls back to `body`
 */
export async function notify({ sms = false, smsText, ...fields }) {
  const row = await Notification.create(fields);
  if (sms) await smsBlast([fields.userId], smsText || fields.body);
  return row;
}

/**
 * Notify several members with the same message: one row each, one batched SMS.
 * @param {Array} userIds recipients
 * @param {object} opts   same shape as notify(), minus userId
 */
export async function notifyAll(userIds, { sms = false, smsText, ...fields }) {
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const rows = await Notification.insertMany(
    ids.map((userId) => ({ ...fields, userId }))
  );
  if (sms) await smsBlast(ids, smsText || fields.body);
  return rows;
}

export default { notify, notifyAll };
