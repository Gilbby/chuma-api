import mongoose from "mongoose";

const { Schema } = mongoose;

const transactionSchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, ref: "Group", index: true },
    groupName: { type: String },
    memberId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    memberName: { type: String },

    type: {
      type: String,
      enum: [
        "contribution",
        "loan",
        "repayment",
        "share-out",
        "penalty",
        "fee",
        "withdrawal",
      ],
      required: true,
      index: true,
    },
    // Signed amount: positive = money in to the member, negative = money out
    amount: { type: Number, required: true },

    contributionType: {
      type: String,
      enum: ["cycle", "topup", "penalty"],
    },
    paymentMethod: {
      type: String,
      enum: [
        "MTN MoMo",
        "Airtel Money",
        "Zamtel Kwacha",
        "Bank Transfer",
        "Cash",
      ],
    },

    status: {
      type: String,
      enum: ["pending", "completed", "failed"],
      default: "completed",
      index: true,
    },

    note: { type: String },
    receiptId: { type: String, index: true },

    // PawaPay linkage
    pawapay: {
      depositId: { type: String },
      payoutId: { type: String },
      status: { type: String }, // ACCEPTED / COMPLETED / FAILED / REJECTED
      failureReason: { type: String },
    },

    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const Transaction = mongoose.model("Transaction", transactionSchema);
export default Transaction;
