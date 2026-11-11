/**
 * Fee-lock grace-period reminder job.
 * Run daily (see cron schedule in src/server.js) or manually for testing:
 *   npm run cron:fee-lock
 *
 * Sends a daily countdown notification to the chairperson and treasurer of any
 * group currently in its grace period (overdue on the monthly fee but not yet
 * locked). Locking itself is computed live by getGraceInfo()/isGroupLocked() on
 * every request, so this job never locks anything - it only reminds.
 */
import { Group } from "../models/Group.js";
import { getGraceInfo, getAmountOwed } from "../services/logic.service.js";
import { notifyAll } from "../services/notify.service.js";
import { User } from "../models/User.js";
import config from "../config/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Play billing: nudge on these days before a free window / plan runs out.
const WARN_ON_DAYS_LEFT = [7, 3, 1];

function isSameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Who hears about a group's Chuma Plan: its founder (the only person who can
 * pay for it) plus the active Chairperson and Treasurer.
 */
function planRecipients(group) {
  const ids = new Set();
  if (group.governance?.chairpersonUserId)
    ids.add(String(group.governance.chairpersonUserId));
  for (const m of group.members || []) {
    if (
      (m.role === "Chairperson" || m.role === "Treasurer") &&
      m.status === "active" &&
      m.userId
    )
      ids.add(String(m.userId));
  }
  return [...ids];
}

/**
 * Pre-deadline nudge (Play billing). Sent 7, 3 and 1 day(s) before a group's
 * cover ends - but only when it will actually end: a group covered by a plan
 * that auto-renews is left alone. Returns true if a warning went out.
 */
async function sendPlanWarning(group, now) {
  if (!group.feePaidThrough) return false;
  const until = new Date(group.feePaidThrough);
  const daysLeft = Math.ceil((until.getTime() - now.getTime()) / DAY_MS);
  if (!WARN_ON_DAYS_LEFT.includes(daysLeft)) return false;
  if (daysLeft > config.billing.warnDaysBefore) return false;

  const last = group.billing?.lastWarningSentAt;
  if (last && isSameCalendarDay(new Date(last), now)) return false;

  if (group.billing?.coveredByPlan) {
    const founder = await User.findById(group.governance?.chairpersonUserId)
      .select("plan")
      .lean();
    if (founder?.plan?.willRenew) return false; // renews by itself
  }

  const legacy = !group.billing?.coveredByPlan;
  const body = legacy
    ? `${group.name}'s free period ends in ${daysLeft} day(s). The group's founder needs to subscribe to the Chuma Plan in the app to keep it open.`
    : `The Chuma Plan subscription for ${group.name} ends in ${daysLeft} day(s) and won't renew. Renew it in the app to keep the group open.`;

  await notifyAll(planRecipients(group), {
    type: "fee",
    title: legacy ? "Free period ending" : "Plan ending",
    body,
    groupId: group._id,
    groupName: group.name,
    // SMS only on the last warning - the earlier ones are in-app.
    sms: daysLeft === 1,
    smsText: `Chuma: ${body}`,
  });
  await Group.updateOne(
    { _id: group._id },
    { $set: { "billing.lastWarningSentAt": new Date() } }
  );
  return true;
}

export async function runFeeLockReminders() {
  const groups = await Group.find({
    monthlyFee: { $exists: true },
    feePaidThrough: { $exists: true },
    // A closed group owes nothing. Chasing its fee would send an SMS about a
    // group that no longer exists for the people getting it.
    status: { $ne: "closed" },
  });

  const now = new Date();
  const play = config.billing.playBillingEnabled;
  let remindedCount = 0;

  for (const group of groups) {
    const grace = getGraceInfo(group);

    // Play billing: before anything is overdue, warn the founder that the
    // group's free window (or a plan that won't renew) is about to end.
    if (play && grace.status === "paid") {
      if (await sendPlanWarning(group, now)) remindedCount++;
      continue;
    }

    // Only groups mid-grace need a countdown. "paid" is fine; "locked" already
    // shows the lock overlay in-app, so no more reminders.
    if (grace.status !== "grace") continue;

    // Never double-send on the same calendar day, even if the job runs twice.
    if (
      group.lastFeeReminderSentAt &&
      isSameCalendarDay(new Date(group.lastFeeReminderSentAt), now)
    )
      continue;

    // Play billing: no kwacha amount - the founder renews or upgrades their
    // Chuma Plan in the app (Google Play), so say that instead.
    if (play) {
      await notifyAll(planRecipients(group), {
        type: "fee",
        title: "Group about to lock",
        body: `${group.name} no longer has an active Chuma Plan subscription. ${grace.daysLeft} day(s) left before the group is locked. The group's founder can renew the subscription in the app.`,
        groupId: group._id,
        groupName: group.name,
        sms: true,
        smsText: `Chuma: ${group.name} locks in ${grace.daysLeft} day(s). The group's founder can renew the Chuma Plan subscription in the app.`,
      });
      await Group.updateOne(
        { _id: group._id },
        { $set: { lastFeeReminderSentAt: new Date() } }
      );
      remindedCount++;
      continue;
    }

    const recipients = group.members.filter(
      (m) =>
        (m.role === "Chairperson" || m.role === "Treasurer") &&
        m.status === "active"
    );

    await notifyAll(
      recipients.map((m) => m.userId),
      {
        type: "fee",
        title: "Group fee overdue",
        body: `${group.name}'s monthly fee is ${grace.daysIntoGrace} day(s) overdue. ${grace.daysLeft} day(s) left before the group is locked. Amount owed: K${getAmountOwed(group)}.`,
        groupId: group._id,
        groupName: group.name,
        // The whole group loses access when the grace period runs out, and
        // only these two can stop it. Worth the credit.
        sms: true,
        smsText: `Chuma: ${group.name}'s monthly fee is ${grace.daysIntoGrace} day(s) overdue. K${getAmountOwed(group)} owed, ${grace.daysLeft} day(s) before the group locks.`,
      }
    );

    // Targeted $set of only the reminder-timestamp field. A full group.save()
    // here would persist every field at its read-time value, clobbering a
    // concurrent settlement's atomic $inc on walletBalance/totalSavings/etc.
    await Group.updateOne(
      { _id: group._id },
      { $set: { lastFeeReminderSentAt: new Date() } }
    );
    remindedCount++;
  }

  console.log(`[feeLockReminders] Reminded ${remindedCount} group(s) in grace period.`);
  return remindedCount;
}

// Standalone run for manual testing: `node src/jobs/feeLockReminders.job.js`
// pathToFileURL handles Windows drive letters and spaces in the path, which a
// naive `file://${process.argv[1]}` comparison gets wrong.
const { pathToFileURL } = await import("url");
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await import("dotenv/config");
  const { connectDB } = await import("../config/db.js");
  const mongoose = (await import("mongoose")).default;

  connectDB()
    .then(() => runFeeLockReminders())
    .then(() => mongoose.disconnect())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
