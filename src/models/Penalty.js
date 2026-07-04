import mongoose from "mongoose";

const { Schema } = mongoose;

const penaltySchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true },
    groupName: { type: String },
    memberId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    memberName: { type: String },

    violationType: {
      type: String,
      enum: ["lateContribution", "missingMeeting", "lateRepayment", "other"],
      required: true,
    },
    reason: { type: String }, // human-readable
    // Admin who manually recorded the violation (absent for auto-detected)
    issuedBy: { type: Schema.Types.ObjectId, ref: "User" },
    issuedByName: { type: String },
    amount: { type: Number, required: true },
    fundsDestination: {
      type: String,
      enum: ["group-pool", "emergency-fund", "welfare-account"],
      default: "group-pool",
    },

    status: {
      type: String,
      enum: ["pending", "paid"],
      default: "pending",
    },
    dueContext: { type: String },
  },
  { timestamps: true }
);

// Group penalty listings and paid-penalty income sums ({ groupId, status })
penaltySchema.index({ groupId: 1, status: 1 });
// "My penalties" listing, newest first
penaltySchema.index({ memberId: 1, createdAt: -1 });

export const Penalty = mongoose.model("Penalty", penaltySchema);
export default Penalty;
