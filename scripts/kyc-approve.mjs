// Manual KYC approval — the background backstop for when Didit auto-declines a
// document it can't read (e.g. the old laminated Zambian NRC back). No Didit
// console visit needed: this flips the user to verified directly in the DB and
// clears their standing "verify your identity" nudge, so they regain access to
// the money-movement routes guarded by requireKyc.
//
// Usage:
//   npm run kyc:list                         # show everyone not yet verified
//   npm run kyc:approve -- <phone|userId>    # approve one user
//   npm run kyc:approve -- <phone|userId> --name "Grace"   # also set display name
//
// phone may be given with or without the +260 prefix.
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import { User } from "../src/models/User.js";
import { Notification } from "../src/models/Notification.js";

const argv = process.argv.slice(2);
const list = argv.includes("--list") || argv[0] === "list";
const nameIdx = argv.indexOf("--name");
const overrideName = nameIdx !== -1 ? argv[nameIdx + 1] : null;
const target = argv.find((a, i) => !a.startsWith("--") && i !== nameIdx + 1);

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

async function findUser(input) {
  if (mongoose.isValidObjectId(input)) {
    const byId = await User.findById(input);
    if (byId) return byId;
  }
  return User.findOne({ phone: { $in: phoneVariants(input) } });
}

async function main() {
  await connectDB();

  if (list || !target) {
    const pending = await User.find({
      $or: [
        { "kyc.status": { $in: ["incomplete", "pending", "rejected"] } },
        { "kyc.status": { $exists: false } },
      ],
    }).select("name phone kyc.status kyc.sessionId");

    if (!pending.length) {
      console.log("No users awaiting KYC — everyone is verified.");
    } else {
      console.log(`${pending.length} user(s) not verified:\n`);
      for (const u of pending) {
        console.log(
          `  ${u.phone.padEnd(15)} ${(u.kyc?.status || "incomplete").padEnd(11)} ${u.name}  (${u._id})`
        );
      }
      console.log(
        `\nApprove with:  npm run kyc:approve -- <phone|userId>`
      );
    }
    if (!target) return;
  }

  const user = await findUser(target);
  if (!user) {
    console.error(`No user found for "${target}".`);
    process.exitCode = 1;
    return;
  }

  const before = user.kyc?.status || "incomplete";
  const existing = user.kyc ? user.kyc.toObject?.() ?? user.kyc : {};
  user.kyc = {
    ...existing,
    provider: "manual",
    status: "verified",
    decisionAt: new Date(),
  };
  if (overrideName) user.name = overrideName;
  await user.save();

  const removed = await Notification.deleteMany({
    userId: user._id,
    type: "kyc",
  });

  console.log(
    `✔ Approved ${user.name} (${user.phone}) — kyc.status ${before} → verified` +
      (removed.deletedCount ? `, cleared ${removed.deletedCount} nudge(s)` : "")
  );
}

main()
  .catch((err) => {
    console.error("kyc-approve failed:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
