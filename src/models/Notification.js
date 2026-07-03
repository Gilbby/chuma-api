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
    penaltyAmount: { type: Number },
    penaltyReason: { type: String },

    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Inbox listing, newest first; the userId prefix also covers read-all updates
notificationSchema.index({ userId: 1, createdAt: -1 });

export const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;
