/**
 * Seed script — populates MongoDB with test data mirroring the app's mock data.
 * Run with: npm run seed
 *
 * Creates: 1 user (you), 3 groups (paid / grace / locked), loans, and a
 * couple of penalties, so you can test the full app against real data.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { connectDB } from "../config/db.js";
import mongoose from "mongoose";
import { User } from "../models/User.js";
import { Group } from "../models/Group.js";
import { Loan } from "../models/Loan.js";
import { Penalty } from "../models/Penalty.js";
import { generateInviteCode } from "./helpers.js";

function daysAgo(d) {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}
function monthsFromNow(m) {
  const d = new Date();
  d.setMonth(d.getMonth() + m);
  return d;
}

async function seed() {
  await connectDB();
  console.log("Clearing existing data…");
  await Promise.all([
    User.deleteMany({}),
    Group.deleteMany({}),
    Loan.deleteMany({}),
    Penalty.deleteMany({}),
  ]);

  const user = await User.create({
    name: "Gilbert",
    phone: "+260975988642",
    pinHash: await bcrypt.hash("1234", 10),
    joinedDate: new Date("2024-01-15"),
    kyc: { status: "verified", fullName: "Gilbert", nrcNumber: "123456/78/1" },
    preferredPayment: {
      method: "Zamtel Kwacha",
      accountName: "Gilbert",
      accountNumber: "+260975988642",
    },
    trustScore: 92,
  });

  const baseMembers = (role) => [
    {
      userId: user._id,
      name: "Gilbert",
      phone: "+260975988642",
      role,
      status: "active",
      savings: 4140,
      contributions: 10,
    },
    { name: "Chisomo Banda", phone: "+260966100200", role: "Member", status: "active", savings: 4800, contributions: 12 },
    { name: "Natasha Phiri", phone: "+260955100201", role: "Member", status: "active", savings: 3200, contributions: 8 },
    { name: "John Mwale", phone: "+260977100202", role: "Member", status: "active", savings: 4400, contributions: 11 },
  ];

  const constitution = {
    penaltyRules: {
      lateContribution: { enabled: true, penaltyType: "percent", penaltyRate: 1 },
      missingMeeting: { enabled: true, penaltyType: "flat", penaltyAmount: 50 },
      lateRepayment: { enabled: true, penaltyType: "percent", penaltyRate: 1 },
    },
    gracePeriodDays: 2,
    loanMultiplier: 3,
    loanInterestRate: 5,
    loanRepaymentMonths: 6,
    internalLendingEnabled: true,
    approvalThreshold: "majority",
    penaltyFundsDestination: "group-pool",
  };

  // g1 — PAID (feePaidThrough in the future)
  const g1 = await Group.create({
    name: "Lusaka Market Sisters",
    description: "Weekly contribution circle for market traders.",
    groupType: "womens-group",
    totalSavings: 248500,
    walletBalance: 42300,
    loanCirculation: 156000,
    contributionAmount: 500,
    contributionFrequency: "Weekly",
    cycleProgress: 0.68,
    shareOutDate: new Date("2026-12-20"),
    loanInterestRate: 5,
    loanMaxMultiplier: 3,
    constitution,
    monthlyFee: 100,
    feeDueDay: 15,
    feePaidThrough: monthsFromNow(1),
    inviteCode: generateInviteCode(),
    members: baseMembers("Chairperson"),
    governance: { chairpersonUserId: user._id },
    healthScore: 92,
    memberRetention: 96,
  });

  // g2 — GRACE (overdue a couple of days)
  const g2 = await Group.create({
    name: "Kabwata Youth Savers",
    description: "Youth savings and investment collective.",
    groupType: "savings-group",
    totalSavings: 134200,
    walletBalance: 28000,
    loanCirculation: 60000,
    contributionAmount: 800,
    contributionFrequency: "Monthly",
    cycleProgress: 0.4,
    shareOutDate: new Date("2027-03-15"),
    loanInterestRate: 5,
    loanMaxMultiplier: 3,
    constitution,
    monthlyFee: 100,
    feeDueDay: 10,
    feePaidThrough: daysAgo(3), // within 5-day grace
    inviteCode: generateInviteCode(),
    members: baseMembers("Treasurer"),
    governance: { chairpersonUserId: user._id },
    healthScore: 86,
    memberRetention: 91,
  });

  // g3 — LOCKED (months overdue)
  const g3 = await Group.create({
    name: "Chongwe Farmers Chuma",
    description: "Seasonal savings for farming inputs.",
    groupType: "cooperative",
    totalSavings: 89400,
    walletBalance: 12000,
    loanCirculation: 40000,
    contributionAmount: 1200,
    contributionFrequency: "Bi-weekly",
    cycleProgress: 0.9,
    shareOutDate: new Date("2026-10-30"),
    loanInterestRate: 3.5,
    loanMaxMultiplier: 3,
    constitution,
    monthlyFee: 100,
    feeDueDay: 20,
    feePaidThrough: daysAgo(75), // ~2-3 months overdue = locked
    inviteCode: generateInviteCode(),
    members: baseMembers("Treasurer"),
    governance: { chairpersonUserId: user._id },
    healthScore: 78,
    memberRetention: 88,
  });

  // A couple of loans
  await Loan.create({
    groupId: g1._id,
    groupName: g1.name,
    memberId: user._id,
    memberName: "Gilbert",
    principal: 5000,
    outstanding: 3750,
    interestRate: 5,
    durationMonths: 6,
    installmentAmount: 880,
    totalInstallments: 6,
    installmentsPaid: 1,
    nextDueDate: monthsFromNow(1),
    status: "active",
    history: [{ amount: 5000, type: "disbursement" }],
  });

  // A pending penalty for the user
  await Penalty.create({
    groupId: g1._id,
    groupName: g1.name,
    memberId: user._id,
    memberName: "Gilbert",
    violationType: "lateContribution",
    reason: "Late contribution",
    amount: 25,
    fundsDestination: "group-pool",
    status: "pending",
  });

  console.log("\n✓ Seed complete");
  console.log(`  User: Gilbert (+260975988642, PIN 1234)`);
  console.log(`  Groups: ${g1.name} (paid), ${g2.name} (grace), ${g3.name} (locked)`);
  console.log(`  Invite codes: ${g1.inviteCode}, ${g2.inviteCode}, ${g3.inviteCode}`);

  await mongoose.connection.close();
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
