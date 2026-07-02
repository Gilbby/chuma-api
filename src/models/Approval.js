import mongoose from "mongoose";

const { Schema } = mongoose;

const voteSchema = new Schema(
  {
    adminId: { type: Schema.Types.ObjectId, ref: "User" },
    adminName: { type: String },
    decision: { type: String, enum: ["approve", "reject"] },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const approvalSchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true },
    groupName: { type: String },

    type: {
      type: String,
      enum: [
        "loan",
        "withdrawal",
        "rule-change",
        "admin-action",
        "member-removal",
        "group-deletion",
        "share-out",
      ],
      required: true,
    },
    title: { type: String },
    description: { type: String },
    amount: { type: Number },

    requestedById: { type: Schema.Types.ObjectId, ref: "User" },
    requestedBy: { type: String },

    // Reference to the entity being approved (loan id, etc.)
    refId: { type: Schema.Types.ObjectId },

    requiredApprovals: { type: Number, default: 2 },
    votes: [voteSchema],

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
  },
  { timestamps: true }
);

// Pending-approval listings per group; also covers the one-pending-share-out check
approvalSchema.index({ groupId: 1, status: 1 });

// Convenience virtuals
approvalSchema.virtual("votesFor").get(function () {
  return this.votes.filter((v) => v.decision === "approve").length;
});
approvalSchema.virtual("votesAgainst").get(function () {
  return this.votes.filter((v) => v.decision === "reject").length;
});
approvalSchema.set("toJSON", { virtuals: true });
approvalSchema.set("toObject", { virtuals: true });

export const Approval = mongoose.model("Approval", approvalSchema);
export default Approval;
