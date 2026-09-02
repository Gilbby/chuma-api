// Change a member's role inside a group. "Admin" in this system is not a role of
// its own — it is any of Chairperson / Treasurer / Secretary (see
// middleware/groupAuth.js ADMIN_ROLES), so promoting someone to admin means
// giving them one of those three.
//
// Usage:
//   npm run role:list -- <phone|userId>                  # show their groups + roles
//   npm run role:set  -- <phone|userId> <Role>           # only if they're in one group
//   npm run role:set  -- <phone|userId> <Role> --group <groupId>
//
// Role is case-insensitive: chairperson | treasurer | secretary | member
// phone may be given with or without the +260 prefix.
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import { User } from "../src/models/User.js";
import { Group } from "../src/models/Group.js";
import { ADMIN_ROLES } from "../src/middleware/groupAuth.js";

const ROLES = ["Chairperson", "Treasurer", "Secretary", "Member"];

const argv = process.argv.slice(2);
const listOnly = argv.includes("--list");
const groupIdx = argv.indexOf("--group");
const groupArg = groupIdx !== -1 ? argv[groupIdx + 1] : null;
const positional = argv.filter(
  (a, i) => !a.startsWith("--") && i !== groupIdx + 1
);
const target = positional[0];
const roleArg = positional[1];

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
  if (!input) return null;
  return ROLES.find((r) => r.toLowerCase() === String(input).toLowerCase()) || null;
}

async function main() {
  if (!target) {
    console.error(
      "Usage: npm run role:set -- <phone|userId> <Chairperson|Treasurer|Secretary|Member> [--group <groupId>]"
    );
    process.exitCode = 1;
    return;
  }

  await connectDB();

  const variants = phoneVariants(target);
  const user = mongoose.isValidObjectId(target)
    ? await User.findById(target)
    : await User.findOne({ phone: { $in: variants } });

  // Members can exist on a group by phone alone (invited, not yet signed up),
  // so match on either the linked userId or any phone spelling.
  const or = [{ "members.phone": { $in: variants } }];
  if (user) or.push({ "members.userId": user._id });
  const groups = await Group.find({ $or: or });

  if (!groups.length) {
    console.error(
      `No group membership found for "${target}"${user ? ` (user ${user.name})` : " (no user account either)"}.`
    );
    process.exitCode = 1;
    return;
  }

  const memberOf = (g) =>
    g.members.find(
      (m) =>
        (user && String(m.userId) === String(user._id)) ||
        variants.includes(m.phone)
    );

  if (listOnly || !roleArg) {
    console.log(
      `${user ? `${user.name} (${user.phone})` : target} is in ${groups.length} group(s):\n`
    );
    for (const g of groups) {
      const m = memberOf(g);
      console.log(
        `  ${String(g._id)}  ${g.name.padEnd(24)} role=${(m?.role || "?").padEnd(12)} status=${m?.status || "?"}`
      );
    }
    if (!roleArg)
      console.log(
        `\nSet with:  npm run role:set -- ${target} <Chairperson|Treasurer|Secretary|Member>` +
          (groups.length > 1 ? " --group <groupId>" : "")
      );
    return;
  }

  const role = normalizeRole(roleArg);
  if (!role) {
    console.error(`Unknown role "${roleArg}". Use one of: ${ROLES.join(", ")}`);
    process.exitCode = 1;
    return;
  }

  let picked = groups;
  if (groupArg)
    picked = groups.filter(
      (g) =>
        String(g._id) === groupArg ||
        g.name.toLowerCase() === groupArg.toLowerCase()
    );

  if (!picked.length) {
    console.error(`They are not a member of group "${groupArg}".`);
    process.exitCode = 1;
    return;
  }
  if (picked.length > 1) {
    console.error(
      `They belong to ${picked.length} groups — pass --group <groupId> to say which:\n` +
        picked.map((g) => `  ${g._id}  ${g.name}`).join("\n")
    );
    process.exitCode = 1;
    return;
  }

  const group = picked[0];
  const member = memberOf(group);
  const before = member.role;
  member.role = role;
  // A pending invite can't hold an admin role in practice — activate on promote.
  if (ADMIN_ROLES.includes(role) && member.status === "pending")
    member.status = "active";
  await group.save();

  console.log(
    `✔ ${member.name} (${member.phone || "no phone"}) in "${group.name}" — role ${before} → ${role}` +
      (ADMIN_ROLES.includes(role) ? "  [group admin]" : "")
  );
}

main()
  .catch((err) => {
    console.error("set-member-role failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
