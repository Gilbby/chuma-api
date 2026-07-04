// One-off manual deposit-status check against PawaPay's GET /deposits/:id.
// Usage: npm run check:deposit -- <depositId>
import "dotenv/config";
import { checkDepositStatus } from "../src/services/pawapay.service.js";

const depositId = process.argv[2];

if (!depositId) {
  console.error("Usage: node scripts/check-deposit.mjs <depositId>");
  process.exit(1);
}

try {
  const result = await checkDepositStatus(depositId);
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (err) {
  console.error("Failed to check deposit status:", err.response?.data ?? err.message);
  process.exit(1);
}
