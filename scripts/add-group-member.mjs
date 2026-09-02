// Put someone into a group directly, skipping the invite → accept round trip.
//
// This is an operator's tool, not a replacement for /invite: the real flow gives
// the invitee an SMS, a notification and the choice to decline, and it is the
// only path an admin has from inside the app. Use this when the invite loop is
// in the way — a test account, a device you can't log into, an invite that was
// cancelled by mistake.
//
// A "removed" row is left exactly as it stands. Someone rejoining gets a FRESH
// row, the same as a re-invite would give them, so the group keeps its record of
// what they saved and contributed in their earlier stint (see memberSchema's
// exit* fields) instead of quietly reviving it as their opening balance.
//
// Usage:
//   npm run member:add -- <phone|userId> --group <groupId|name>
//   npm run member:add -- <phone|userId> --group <groupId|name> --role Treasurer
//   npm run member:add -- <phone|userId> --group <groupId|name> --pending
//   npm run member:add -- <phone|userId> --group <groupId|name> --activate
//
// Role is case-insensitive and defaults to Member. --pending adds them as an
// unanswered invite instead of an active member. --activate answers an invite
// they already have, which is the same end state as them tapping Accept: the
// row goes active and picks up their account's name and userId. Without it, an
// existing invite is left alone and the script refuses — answering for someone
// is not something to do by accident.
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import { User } from "../src/models/User.js";
import { Group } from "../src/models/Group.js";

// Chairperson is deliberately missing: the chair is set when the group is
// created and lives on governance.chairpersonUserId as well as the member row,
// so handing it out here would leave the two disagreeing.
const ROLES = ["Treasurer", "Secretary", "Member"];
const SINGLE_SEAT = ["Treasurer", "Secretary"];

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const groupArg = flagValue("--group");
const roleArg = flagValue("--role");
const pending = argv.includes("--pending");
const activate = argv.includes("--activate");
const consumed = new Set();
for (const name of ["--group", "--role"]) {
  const i = argv.indexOf(name);
  if (i !== -1) consumed.add(i + 1);
}
const target = argv.find((a, i) => !a.startsWith("--") && !consumed.has(i));

// Match a raw input against a stored phone, tolerating the +260 country prefix.
function phoneVariants(input) {
  const digits = String(input).replace(/[^\d]/g, "");
  const variants = new Set([input, `+${digits}`, digits]);
  if (digits.startsWith("260")) variants.add(`+${digits}`);
  if (digits.startsWith("0")) variants.add(`+260${digits.slice(1)}`);
  if (!digits.startsWith("260") && !digits.startsWith("0"))
    variants.add(`+260${digits}`);
  return [...variants];
}

function normalizeRole(input) {
  if (!input) return "Member";
  return ROLES.find((r) => r.toLowerCase() === String(input).toLowerCase()) || null;
}

async function main() {
  if (!target || !groupArg) {
    console.error(
      "Usage: npm run member:add -- <phone|userId> --group <groupId|name> [--role Member|Treasurer|Secretary] [--pending]"
    );
    process.exitCode = 1;
    return;
  }

  const role = normalizeRole(roleArg);
  if (!role) {
    console.error(`Unknown role "${roleArg}". Use one of: ${ROLES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  await connectDB();

  const variants = phoneVariants(target);
  const user = mongoose.isValidObjectId(target)
    ? await User.findById(target)
    : await User.findOne({ phone: { $in: variants } });

  // The canonical spelling is the one on their account; fall back to the +260
  // form so a member added before they sign up still matches at login.
  const phone =
    user?.phone ||
    variants.find((v) => v.startsWith("+260")) ||
    variants[variants.length - 1];

  const group = mongoose.isValidObjectId(groupArg)
    ? await Group.findById(groupArg)
    : await Group.findOne({ name: groupArg });
  if (!group) {
    console.error(`No group matching "${groupArg}".`);
    process.exitCode = 1;
    return;
  }

  // Same test the /invite route applies: a removed row is history and does not
  // block, anything else means they are already in this group.
  const existing = group.members.find(
    (m) =>
      m.status !== "removed" &&
      (variants.includes(m.phone) ||
        (user && m.userId && String(m.userId) === String(user._id)))
  );
  if (existing && !(activate && existing.status === "pending")) {
    console.error(
      `${existing.name} is already ${existing.status === "pending" ? "invited to" : `a ${existing.role} in`} "${group.name}".` +
        (existing.status === "pending"
          ? `\nAnswer that invite instead:  npm run member:add -- ${target} --group ${group._id} --activate`
          : "")
    );
    process.exitCode = 1;
    return;
  }

  // Answer an invite they already hold, the way /accept would: the row goes
  // active and takes the name and userId from their account, which is what
  // links the group to them if they signed up after being invited.
  if (existing) {
    const before = existing.role;
    if (roleArg) existing.role = role;
    existing.status = "active";
    if (user) {
      existing.userId = user._id;
      existing.name = user.name;
    }
    await group.save();
    console.log(
      `✔ ${existing.name} joined "${group.name}" as ${existing.role} — invite accepted` +
        (roleArg && before !== existing.role ? ` (role ${before} → ${existing.role})` : "") +
        (user ? "" : "\n  No account for this number yet, so the row is still phone-only.")
    );
    return;
  }

  if (SINGLE_SEAT.includes(role)) {
    const held = group.members.find(
      (m) => m.status !== "removed" && m.role === role
    );
    if (held) {
      console.error(
        `"${group.name}" already has a ${role.toLowerCase()} (${held.name}).`
      );
      process.exitCode = 1;
      return;
    }
  }

  const rejoining = group.members.some(
    (m) =>
      m.status === "removed" &&
      (variants.includes(m.phone) ||
        (user && m.userId && String(m.userId) === String(user._id)))
  );

  group.members.push({
    userId: user?._id,
    name: user?.name || phone,
    phone,
    role,
    status: pending ? "pending" : "active",
    ...(pending ? { invitedAt: new Date(), lastInviteSentAt: new Date() } : {}),
  });
  await group.save();

  console.log(
    `✔ ${user?.name || phone} added to "${group.name}" as ${role} (${pending ? "pending invite" : "active"})` +
      (rejoining ? "  [rejoining — earlier stint kept as history]" : "") +
      (user ? "" : "\n  No account for this number yet: they join it by signing up with this phone.")
  );
}

main()
  .catch((err) => {
    console.error("add-group-member failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
