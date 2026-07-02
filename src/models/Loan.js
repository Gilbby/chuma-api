import mongoose from "mongoose";

const { Schema } = mongoose;

const loanHistorySchema = new Schema(
  {
    date: { type: Date, default: Date.now },
    amount: { type: Number, required: true },
    type: {
      type: String,
      enum: ["disbursement", "repayment"],
      required: true,
    },
  },
  { _id: false }
);

const loanSchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true },
    groupName: { type: String },
    memberId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    memberName: { type: String },

    principal: { type: Number, required: true },
    outstanding: { type: Number, required: true },
    interestRate: { type: Number, default: 5 }, // % per month
    durationMonths: { type: Number, default: 6 },
    installmentAmount: { type: Number },
    nextDueDate: { type: Date },
    installmentsPaid: { type: Number, default: 0 },
    totalInstallments: { type: Number },

    reason: { type: String }, // optional loan purpose

    status: {
      type: String,
      enum: ["pending", "active", "repaid", "rejected", "overdue"],
      default: "pending",
    },

    history: [loanHistorySchema],

    // Approval tracking (denormalised; full vote record in Approval model)
    approvalId: { type: Schema.Types.ObjectId, ref: "Approval" },
  },
  { timestamps: true }
);

// Covers group loan listings and open-loan counts ({ groupId, status })
loanSchema.index({ groupId: 1, status: 1 });

export const Loan = mongoose.model("Loan", loanSchema);
export default Loan;
