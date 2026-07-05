import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import mongoSanitize from "express-mongo-sanitize";
import cron from "node-cron";

import config from "./config/index.js";
import { connectDB } from "./config/db.js";
import { notFound, errorHandler } from "./middleware/error.js";
import {
  apiLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
} from "./middleware/rateLimits.js";
import { runFeeLockReminders } from "./jobs/feeLockReminders.job.js";
import { runPenaltyDetection } from "./jobs/penaltyDetection.job.js";
import { runStatusReconciliation } from "./jobs/statusReconciliation.job.js";

import authRoutes from "./routes/auth.routes.js";
import groupRoutes from "./routes/group.routes.js";
import contributionRoutes from "./routes/contribution.routes.js";
import loanRoutes from "./routes/loan.routes.js";
import approvalRoutes from "./routes/approval.routes.js";
import shareoutRoutes from "./routes/shareout.routes.js";
import miscRoutes from "./routes/misc.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";

const app = express();

// Behind a reverse proxy (Render/Railway/nginx) the client IP arrives in
// X-Forwarded-For; without this, rate limits key on the proxy's IP.
app.set("trust proxy", 1);

app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
    credentials: true,
  })
);
app.use(compression());
// Payloads are small JSON (no base64 uploads); keep the limit tight
app.use(
  express.json({
    limit: "100kb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }, // raw bytes for webhook signature verification
  })
);
// Strip $ and . operators from user input (NoSQL injection)
app.use(mongoSanitize());
app.use(morgan(config.env === "development" ? "dev" : "combined"));

// Rate limiting (see middleware/rateLimits.js): a generous global per-IP
// backstop, tight per-IP caps on the OTP endpoints (SMS costs money), and
// per-user caps on payment/SMS actions applied inside the route files.
app.use("/api", apiLimiter);
app.use("/api/auth/request-otp", otpRequestLimiter);
app.use("/api/auth/verify-otp", otpVerifyLimiter);

// Health check
app.get("/", (req, res) =>
  res.json({
    service: "Chuma Backend",
    status: "ok",
    env: config.env,
    paymentsEnabled: config.pawapay.paymentsEnabled,
    smsEnabled: config.africasTalking.smsEnabled,
  })
);
app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date() }));

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/groups", groupRoutes);
app.use("/api/contributions", contributionRoutes);
app.use("/api/loans", loanRoutes);
app.use("/api/approvals", approvalRoutes);
app.use("/api/shareout", shareoutRoutes);
app.use("/api", miscRoutes); // penalties, notifications, transactions, reports
app.use("/api/webhooks", webhookRoutes);

// 404 + errors
app.use(notFound);
app.use(errorHandler);

async function start() {
  await connectDB();

  // Daily at 08:00 server time: remind chairperson/treasurer of groups in the
  // fee grace period, counting down days left before lock.
  cron.schedule("0 8 * * *", runFeeLockReminders);
  console.log("   Cron: fee-lock reminders scheduled (daily 08:00)");

  // Daily at 08:15 server time (staggered after the fee-lock job): auto-detect
  // late contributions and late loan repayments, issuing penalties idempotently.
  cron.schedule("15 8 * * *", runPenaltyDetection);
  console.log("   Cron: penalty detection scheduled (daily 08:15)");

  // Every 5 minutes: poll PawaPay for pending transactions whose final-status
  // callback never arrived and apply the same atomic transition the webhook does.
  cron.schedule("*/5 * * * *", runStatusReconciliation);
  console.log("   Cron: status reconciliation scheduled (every 5 min)");

  app.listen(config.port, () => {
    console.log(`\n Chuma backend running on port ${config.port}`);
    console.log(`   Env: ${config.env}`);
    console.log(
      `   Payments: ${config.pawapay.paymentsEnabled ? "LIVE (PawaPay)" : "SIMULATED"}`
    );
    console.log(
      `   SMS: ${config.africasTalking.smsEnabled ? "LIVE (AfricasTalking)" : "SIMULATED"}`
    );
    console.log(`   Public URL: ${config.publicBaseUrl}\n`);
  });
}

start();

export default app;
