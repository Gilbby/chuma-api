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
        // An admin acknowledging that cash physically reached them. Unlike the
        // rest of this list it is a receipt, not a group decision, so it needs
        // ONE admin rather than a quorum — but it moves real money into a
        // member's savings, so it belongs in the same audited place.
        "cash-receipt",
      ],
      required: true,
    },
    title: { type: String },
    description: { type: String },
    amount: { type: Number },

    requestedById: { type: Schema.Types.ObjectId, ref: "User" },
    requestedBy: { type: String },

    // Reference to the entity being approved (loan id, member row id, etc.)
    refId: { type: Schema.Types.ObjectId },

    // Who a "member-removal" is about. They may hold an admin role themselves,
    // and nobody votes on their own removal — the vote route reads this to keep
    // them out of the quorum that decides it.
    targetUserId: { type: Schema.Types.ObjectId, ref: "User" },
    targetName: { type: String },

    // How a share-out approval will pay members, chosen when it is proposed
    // and fixed for that whole run. Voters are approving a method as much as an
    // amount: "manual" commits the group to paying every member themselves —
    // notes, their own mobile money, a bank transfer — and confirming each one
    // in the app; "mobile-money" is one approval and then pawaPay does the
    // rest. The mobile money hold overrides it either way — see paymentHold.js.
    payoutMethod: {
      type: String,
      enum: ["manual", "mobile-money"],
    },

    requiredApprovals: { type: Number, default: 2 },
    votes: [voteSchema],

    status: {
      type: String,
      // "executed" marks approvals whose action has run (prevents double
      // execution of share-outs and similar one-shot actions)
      enum: ["pending", "approved", "rejected", "executed"],
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
