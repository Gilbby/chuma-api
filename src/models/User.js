import mongoose from "mongoose";

const { Schema } = mongoose;

const userSchema = new Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true, unique: true, index: true },
    pinHash: { type: String }, // hashed app PIN
    // Set on OTP verification; allows a PIN reset shortly after proving
    // phone ownership (so a stolen JWT alone can't change the PIN)
    pinResetAllowedUntil: { type: Date },
    avatar: { type: String },
    joinedDate: { type: Date, default: Date.now },

    // KYC — verified via Didit.me (see services/didit.service.js)
    kyc: {
      provider: { type: String }, // "didit" | "didit-sim"
      sessionId: { type: String, index: true }, // Didit session id
      firstName: { type: String }, // verified first name (used as display name)
      fullName: { type: String },
      dateOfBirth: { type: Date },
      documentNumber: { type: String }, // NRC / passport number
      documentType: { type: String },
      nrcNumber: { type: String }, // legacy manual-entry field
      photoUrl: { type: String }, // legacy manual-entry field
      decisionAt: { type: Date },
      // Set true for accounts created via app signup — these must complete KYC
      // before entering the app (hard gate). Users seeded/added directly (no
      // flag) keep full access and only get the soft verification nudge.
      onboardingRequired: { type: Boolean },
      status: {
        type: String,
        enum: ["incomplete", "pending", "verified", "rejected"],
        default: "incomplete",
      },
    },

    // Preferred payout/payment wallet (must be in account holder's name)
    preferredPayment: {
      method: {
        type: String,
        enum: [
          "MTN MoMo",
          "Airtel Money",
          "Zamtel Kwacha",
          "Bank Transfer",
          "Cash",
        ],
        default: "Airtel Money",
      },
      accountName: { type: String },
      accountNumber: { type: String }, // wallet number or bank account
    },

    // Trust score is computed, but we cache the last value
    trustScore: { type: Number, default: 70 },
  },
  { timestamps: true }
);

export const User = mongoose.model("User", userSchema);
export default User;
