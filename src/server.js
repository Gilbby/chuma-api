import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import config from "./config/index.js";
import { connectDB } from "./config/db.js";
import { notFound, errorHandler } from "./middleware/error.js";

import authRoutes from "./routes/auth.routes.js";
import groupRoutes from "./routes/group.routes.js";
import contributionRoutes from "./routes/contribution.routes.js";
import loanRoutes from "./routes/loan.routes.js";
import approvalRoutes from "./routes/approval.routes.js";
import shareoutRoutes from "./routes/shareout.routes.js";
import miscRoutes from "./routes/misc.routes.js";
import webhookRoutes from "./routes/webhook.routes.js";

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: config.corsOrigins.includes("*") ? true : config.corsOrigins,
    credentials: true,
  })
);
app.use(compression());
// Payloads are small JSON (no base64 uploads); keep the limit tight
app.use(express.json({ limit: "100kb" }));
app.use(morgan(config.env === "development" ? "dev" : "combined"));

// Basic rate limiting on auth (OTP abuse protection)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

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
app.use("/api/auth", authLimiter, authRoutes);
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
  app.listen(config.port, () => {
    console.log(`\n🚀 Chuma backend running on port ${config.port}`);
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
