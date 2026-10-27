import mongoose from "mongoose";

const { Schema } = mongoose;

/**
 * A church group's cash handler saying where cash they were holding went.
 *
 * Mobile money is off for member money, so a church group's giving reaches it
 * outside the app: notes handed to the treasurer, or a transfer straight into
 * the church's own bank / mobile-money account. A transfer lands where it
 * belongs; cash does not - it sits with whoever confirmed it until they bank
 * it, put it on mobile money, or spend it on a project. Each of those is one of
 * these. See funds.service.js for how they roll up into where the money is.
 *
 * Bank and mobile money are final: nothing records money leaving the church
 * accounts, so cash still in hand is the only money ever paid out here.
 */
const cashDeliverySchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, ref: "Group", required: true },

    // The pile the cash came out of: the project it was given toward, or null
    // for giving that named no project ("General giving").
    sourceProjectId: { type: Schema.Types.ObjectId, default: null },

    destination: {
      type: String,
      // "other" is a free-text destination (destinationNote) the handler
      // describes; "mobile-money" is kept for older records but no longer
      // offered by the app.
      enum: ["bank", "mobile-money", "project", "other"],
      required: true,
    },

    // destination "project" only: what it was paid for. A project's own cash
    // can only pay for that project; General giving can pay for any - or for
    // none, when it was spent on something that is no project (null).
    targetProjectId: { type: Schema.Types.ObjectId, default: null },

    amount: { type: Number, required: true, min: 0.01 },

    // Deposit slip / transaction ID for a deposit; receipt number, if there
    // was one, for a payment.
    reference: { type: String, trim: true, maxlength: 60 },
    // destination "other" only: free text saying where the cash went.
    destinationNote: { type: String, trim: true, maxlength: 140 },
    // destination "project" only: who was paid.
    payee: { type: String, trim: true, maxlength: 80 },

    // Set when one payout of everything in hand was split across piles: the
    // rows that share it are the one deposit / payment the cash handler made.
    batchId: { type: Schema.Types.ObjectId },

    recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    recordedByName: { type: String },
    recordedByRole: { type: String },

    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

cashDeliverySchema.index({ groupId: 1, date: -1 });

export const CashDelivery = mongoose.model("CashDelivery", cashDeliverySchema);
export default CashDelivery;
