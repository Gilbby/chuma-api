import mongoose from "mongoose";

const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    // Recipient
    userId: { type: Schema.Types.ObjectId, ref: "User" },

    type: {
      type: String,
      enum: [
        "loan",
        "contribution",
        "governance",
        "security",
        "repayment",
        "invite",
        "penalty",
        "fee",
        "kyc",
      ],
      required: true,
    },
    title: { type: String, required: true },
    body: { type: String },
    read: { type: Boolean, default: false },

    // Optional context
    groupId: { type: Schema.Types.ObjectId, ref: "Group" },
    groupName: { type: String },
    invitedBy: { type: String },

    // For penalty notifications
    penaltyId: { type: Schema.Types.ObjectId, ref: "Penalty" },
    // For actionable payment notifications (e.g. cash-receipt confirmation)
    transactionId: { type: Schema.Types.ObjectId, ref: "Transaction" },
    penaltyAmount: { type: Number },
    penaltyReason: { type: String },

    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Inbox listing, newest first; the userId prefix also covers read-all updates
notificationSchema.index({ userId: 1, createdAt: -1 });
// Auto-expire after 180 days: notifications are ephemeral (the app shows the
// latest 100) and this keeps the collection from growing without bound.
notificationSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 180 * 24 * 60 * 60 }
);

export const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;
