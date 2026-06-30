import mongoose from "mongoose";

const { Schema } = mongoose;

const notificationSchema = new Schema(
  {
    // Recipient
    userId: { type: Schema.Types.ObjectId, ref: "User", index: true },

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

export const Notification = mongoose.model("Notification", notificationSchema);
export default Notification;
