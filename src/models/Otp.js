import mongoose from "mongoose";

const { Schema } = mongoose;

const otpSchema = new Schema(
  {
    phone: { type: String, required: true },
    codeHash: { type: String, required: true },
    purpose: {
      type: String,
      enum: ["signup", "signin"],
      default: "signup",
    },
    expiresAt: { type: Date, required: true },
    consumed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Auto-delete expired OTPs
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// Verify-OTP lookup: latest unconsumed code for a phone + purpose
otpSchema.index({ phone: 1, purpose: 1, consumed: 1, createdAt: -1 });

export const Otp = mongoose.model("Otp", otpSchema);
export default Otp;
