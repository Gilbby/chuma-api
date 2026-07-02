/**
 * Seed script — clean slate for the invite-only launch.
 * Run with: npm run seed
 *
 * Creates ONLY the Gilbert user. No groups/members/loans/penalties —
 * groups are created in-app and users invited from there.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { connectDB } from "../config/db.js";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { Group } from "../models/Group.js";
import { Loan } from "../models/Loan.js";
import { Penalty } from "../models/Penalty.js";
import { Transaction } from "../models/Transaction.js";
import { Approval } from "../models/Approval.js";
import { Notification } from "../models/Notification.js";
import { Otp } from "../models/Otp.js";

async function seed() {
  await connectDB();
  console.log("Clearing existing data…");
  await Promise.all([
    User.deleteMany({}),
    Group.deleteMany({}),
    Loan.deleteMany({}),
    Penalty.deleteMany({}),
    Transaction.deleteMany({}),
    Approval.deleteMany({}),
    Notification.deleteMany({}),
    Otp.deleteMany({}),
  ]);

  await User.create({
    name: "Gilbert",
    phone: "+260975988642",
    pinHash: await bcrypt.hash("1234", 10),
    joinedDate: new Date("2024-01-15"),
    kyc: { status: "verified", fullName: "Gilbert", nrcNumber: "123456/78/1" },
    preferredPayment: {
      method: "Airtel Money",
      accountName: "Gilbert",
      accountNumber: "+260975988642",
    },
    trustScore: 92,
  });

  console.log("\n✓ Seed complete — clean slate");
  console.log(`  User: Gilbert (+260975988642, PIN 1234)`);
  console.log(`  No groups seeded — create one in-app and invite users.`);

  await mongoose.connection.close();
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
