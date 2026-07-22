import mongoose from "mongoose";

const { Schema } = mongoose;

const transactionSchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, ref: "Group" },
    groupName: { type: String },
    memberId: { type: Schema.Types.ObjectId, ref: "User" },
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
        // One deposit settling several obligations at once (savings + loan
        // repayment(s) + penalties) — see the "combined" branch of
        // settlement.service.js. meta carries the full breakdown.
        "combined",
      ],
      required: true,
    },
    // Signed amount: positive = money in to the member, negative = money out.
    // amount = the BASE figure — what the member typed = what gets pooled/credited.
    amount: { type: Number, required: true },

    // depositAmount = grossed-up total actually charged to the member (requested
    // from PawaPay). platformFee = the platform charge on this txn (platform revenue,
    // never pooled). Both only set on the contribution/deposit flow; other txn types
    // leave them unset.
    depositAmount: { type: Number },
    platformFee: { type: Number, default: 0 },

    // feesAbsorbed = provider fees Chuma paid so the member received the full
    // amount (loan disbursement). Booked as NEGATIVE platform revenue on
    // settlement — a cash cost, the mirror of platformFee.
    feesAbsorbed: { type: Number, default: 0 },

    // networkFee = the member's OWN mobile network charge on a collection (money
    // in), debited from their wallet by their MMO. Display-only — we never
    // collect it. Stored so the receipt can show it after payment.
    networkFee: { type: Number, default: 0 },

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
    },

    note: { type: String },
    receiptId: { type: String, index: true },

    // Settlement linkage — what the settlement service needs to apply this
    // transaction's effects once payment completes (see settlement.service.js):
    // penalty:{penaltyId} fee:{months} repayment/loan:{loanId}
    // share-out:{memberSavings}
    // combined:{ contribution, topup, repayments:[{loanId,amount}], penaltyIds:[] }
    meta: { type: Schema.Types.Mixed },

    // PawaPay linkage
    pawapay: {
      depositId: { type: String },
      payoutId: { type: String }, // legacy single-payout linkage (deposits still use depositId)
      status: { type: String }, // parent aggregate: ACCEPTED / COMPLETED / FAILED / REJECTED
      failureReason: { type: String },

      // Payouts settle as one or more transfers: a large payout is split into
      // ≤operator-ceiling chunks because an account can't receive more than the
      // ceiling in one go (see config splitForPayout). The parent transaction
      // settles ONLY when every transfer COMPLETES; reconciliation (webhook /
      // cron) marks each transfer by its own payoutId. A normal payout is just
      // one transfer (N=1). Retry re-sends only the non-COMPLETED transfers.
      transfers: [
        {
          _id: false,
          payoutId: { type: String },
          amount: { type: Number },
          status: { type: String }, // ACCEPTED / COMPLETED / FAILED / REJECTED
          failureReason: { type: String },
        },
      ],
    },

    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Ledger listings: member history and group ledger, newest first
transactionSchema.index({ memberId: 1, date: -1 });
transactionSchema.index({ groupId: 1, date: -1 });
// Webhook lookups by PawaPay id (sparse: most cash/simulated txns have none)
transactionSchema.index({ "pawapay.depositId": 1 }, { sparse: true });
transactionSchema.index({ "pawapay.payoutId": 1 }, { sparse: true });
// Reconciliation looks up the parent payout by an individual transfer's payoutId
transactionSchema.index({ "pawapay.transfers.payoutId": 1 }, { sparse: true });

export const Transaction = mongoose.model("Transaction", transactionSchema);
export default Transaction;
