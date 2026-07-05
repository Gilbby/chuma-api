/**
 * Fee-lock grace-period reminder job.
 * Run daily (see cron schedule in src/server.js) or manually for testing:
 *   npm run cron:fee-lock
 *
 * Sends a daily countdown notification to the chairperson and treasurer of any
 * group currently in its grace period (overdue on the monthly fee but not yet
 * locked). Locking itself is computed live by getGraceInfo()/isGroupLocked() on
 * every request, so this job never locks anything — it only reminds.
 */
import { Group } from "../models/Group.js";
import { Notification } from "../models/Notification.js";
import { getGraceInfo, getAmountOwed } from "../services/logic.service.js";

function isSameCalendarDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export async function runFeeLockReminders() {
  const groups = await Group.find({
    monthlyFee: { $exists: true },
    feePaidThrough: { $exists: true },
  });

  const now = new Date();
  let remindedCount = 0;

  for (const group of groups) {
    const grace = getGraceInfo(group);
    // Only groups mid-grace need a countdown. "paid" is fine; "locked" already
    // shows the lock overlay in-app, so no more reminders.
    if (grace.status !== "grace") continue;

    // Never double-send on the same calendar day, even if the job runs twice.
    if (
      group.lastFeeReminderSentAt &&
      isSameCalendarDay(new Date(group.lastFeeReminderSentAt), now)
    )
      continue;

    const recipients = group.members.filter(
      (m) =>
        (m.role === "Chairperson" || m.role === "Treasurer") &&
        m.status === "active"
    );

    for (const member of recipients) {
      await Notification.create({
        userId: member.userId,
        type: "fee",
        title: "Group fee overdue",
        body: `${group.name}'s monthly fee is ${grace.daysIntoGrace} day(s) overdue. ${grace.daysLeft} day(s) left before the group is locked. Amount owed: K${getAmountOwed(group)}.`,
        groupId: group._id,
        groupName: group.name,
      });
    }

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
