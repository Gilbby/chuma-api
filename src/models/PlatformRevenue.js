import mongoose from "mongoose";

const { Schema } = mongoose;

const platformRevenueSchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, ref: "Group", index: true },
    // unique+sparse: a given transaction can only ever book platform revenue
    // once (idempotency guard for replayed settlement callbacks).
    transactionId: {
      type: Schema.Types.ObjectId,
      ref: "Transaction",
      index: true,
      unique: true,
      sparse: true,
    },
    userId: { type: Schema.Types.ObjectId, ref: "User" }, // who paid it
    amount: { type: Number, required: true }, // the platform fee earned (e.g. K2)
    source: {
      type: String,
      enum: ["contribution", "payout", "other"],
      default: "contribution",
    },
    currency: { type: String, default: "ZMW" },
  },
  { timestamps: true }
);

export const PlatformRevenue = mongoose.model(
  "PlatformRevenue",
  platformRevenueSchema
);
export default PlatformRevenue;
