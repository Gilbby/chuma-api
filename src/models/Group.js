import mongoose from "mongoose";

const { Schema } = mongoose;

// Embedded member subdocument (mirrors the app's Member type)
const memberSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    name: { type: String, required: true },
    phone: { type: String },
    role: {
      type: String,
      enum: ["Chairperson", "Treasurer", "Secretary", "Member"],
      default: "Member",
    },
    avatar: { type: String },
    invitedByName: { type: String },
    savings: { type: Number, default: 0 }, // this member's savings in the group
    contributions: { type: Number, default: 0 }, // count of contributions made
    loanActive: { type: Number, default: 0 }, // outstanding loan amount
    status: {
      type: String,
      enum: ["pending", "active", "removed"],
      default: "active",
    },
  },
  { _id: true }
);

const penaltyRuleSchema = new Schema(
  {
    enabled: { type: Boolean, default: false },
    penaltyType: { type: String, enum: ["flat", "percent"], default: "percent" },
    penaltyRate: { type: Number }, // % per day (capped at 30 in logic)
    penaltyAmount: { type: Number }, // flat fee
  },
  { _id: false }
);

const groupSchema = new Schema(
  {
    name: { type: String, required: true },
    description: { type: String },
    groupType: {
      type: String,
      enum: [
        "savings-group",
        "cooperative",
        "womens-group",
        "church-group",
        "investment-group",
      ],
      default: "savings-group",
    },
    avatar: { type: String },

    // Financial rollups (recomputed as transactions occur)
    totalSavings: { type: Number, default: 0 },
    walletBalance: { type: Number, default: 0 },
    loanCirculation: { type: Number, default: 0 },

    // Cycle
    contributionAmount: { type: Number, default: 0 },
    contributionFrequency: {
      type: String,
      enum: ["Weekly", "Bi-weekly", "Monthly"],
      default: "Monthly",
    },
    cycleProgress: { type: Number, default: 0 }, // 0..1
    shareOutDate: { type: Date },
    nextContributionDate: { type: Date },

    // Loan rules
    loanInterestRate: { type: Number, default: 5 }, // % per month
    loanMaxMultiplier: { type: Number, default: 3 },

    // Constitution
    constitution: {
      penaltyRules: {
        lateContribution: { type: penaltyRuleSchema, default: () => ({}) },
        missingMeeting: { type: penaltyRuleSchema, default: () => ({}) },
        lateRepayment: { type: penaltyRuleSchema, default: () => ({}) },
      },
      gracePeriodDays: { type: Number, default: 2 },
      loanMultiplier: { type: Number, default: 3 },
      loanInterestRate: { type: Number, default: 5 },
      loanRepaymentMonths: { type: Number, default: 6 },
      internalLendingEnabled: { type: Boolean, default: true },
      approvalThreshold: {
        type: String,
        enum: ["2-of-3", "majority", "all"],
        default: "majority",
      },
      penaltyFundsDestination: {
        type: String,
        enum: ["group-pool", "emergency-fund", "welfare-account"],
        default: "group-pool",
      },
    },

    // Governance
    governance: {
      chairpersonUserId: { type: Schema.Types.ObjectId, ref: "User" },
      treasurerPhone: { type: String },
      secretaryPhone: { type: String },
      permissions: {
        loanApprovals: { type: Boolean, default: true },
        withdrawals: { type: Boolean, default: true },
        ruleChanges: { type: Boolean, default: true },
        memberRemovals: { type: Boolean, default: true },
        shareOutApprovals: { type: Boolean, default: true },
      },
    },

    members: [memberSchema],

    // Monthly fee / lock state
    monthlyFee: { type: Number, default: 100 },
    feeDueDay: { type: Number }, // day of month (1-28), matches creation day
    feePaidThrough: { type: Date }, // paid up to this date
    lastFeeReminderSentAt: { type: Date }, // last day a grace reminder was sent

    // Health analytics (cached; recomputed)
    healthScore: { type: Number },
    savingsGrowth: { type: Number },
    repaymentRate: { type: Number },
    defaults: { type: Number },
    memberRetention: { type: Number },

    status: {
      type: String,
      enum: ["active", "closed", "deletion-pending"],
      default: "active",
    },
  },
  { timestamps: true }
);

// "My groups" is the hottest query: Group.find({ "members.userId": ... })
groupSchema.index({ "members.userId": 1 });

export const Group = mongoose.model("Group", groupSchema);
export default Group;
