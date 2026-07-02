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

    // KYC / NRC
    kyc: {
      nrcNumber: { type: String },
      fullName: { type: String },
      dateOfBirth: { type: Date },
      photoUrl: { type: String },
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
