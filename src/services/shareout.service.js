import { Penalty } from "../models/Penalty.js";
import { Transaction } from "../models/Transaction.js";
import { generateReceiptId } from "../utils/helpers.js";
import { computeShareOut, estimateGroupProfit } from "./logic.service.js";
import { initiatePayout, providerFromPhone } from "./pawapay.service.js";
import { pricePayout } from "./pricing.service.js";
import { config } from "../config/index.js";
import {
  settleCompletedTransaction,
  handleFailedTransaction,
} from "./settlement.service.js";

/**
 * Pays each active member their share of the group's pool via PawaPay payout,
 * records share-out Transactions, then resets the cycle (zeroes savings /
 * contributions / totalSavings / cycleProgress) and saves the group.
 */
export async function distributeShareOut(group) {
  const [penaltyRow] = await Penalty.aggregate([
    {
      $match: {
        groupId: group._id,
        status: "paid",
        fundsDestination: "group-pool",
      },
    },
    { $group: { _id: null, total: { $sum: "$amount" } } },
  ]);
  const penaltyIncome = penaltyRow?.total || 0;

  const cycleMonths = group.constitution?.loanRepaymentMonths || 12;
  const profit = estimateGroupProfit(
    group.loanCirculation || 0,
    group.loanInterestRate || 0,
    cycleMonths,
    penaltyIncome
  );

  const activeMembers = group.members.filter((m) => m.status === "active");
  const members = activeMembers.map((m) => ({
    id: String(m.userId || m._id),
    name: m.name,
    contribution: m.savings,
  }));
  const result = computeShareOut(members, profit);

  // Payouts draw real money from the merchant float. If the wallet can't
  // cover the whole pot (outstanding loans still hold the cash, or the profit
  // estimate exceeds what was actually collected), refuse BEFORE any payout
  // goes out — status 409 lets callers keep the approval usable for later.
  const wallet = group.walletBalance || 0;
  if (result.totalToDistribute > wallet) {
    const err = new Error(
      `Share-out of K${result.totalToDistribute} exceeds the group wallet (K${wallet}). Collect outstanding loan repayments first, then distribute again.`
    );
    err.status = 409;
    throw err;
  }

  // Pay each member their share
  const payouts = [];
  for (const m of activeMembers) {
    const calc = result.members.find(
      (r) => r.id === String(m.userId || m._id)
    );
    if (!calc || calc.share <= 0) continue;

    // Deduct fees (PawaPay % + MNO + platform fee) from what the member is
    // OWED (calc.share). The pool still decrements by the full owed at
    // settlement; we just SEND the remainder. pricePayout THROWS when the fees
    // meet or exceed the share (tiny stakes) — skip that member rather than
    // crash the whole share-out. Their savings stay untouched (like a failed
    // payout) so they can be handled manually.
    let priced;
    try {
      priced = pricePayout({
        owed: calc.share,
        platformFee: config.pricing.platformFee,
        pawapayRate: config.pricing.pawapayRate,
        feesOnEndUser: config.pricing.feesOnEndUser,
        mnoFee: config.pricing.mnoFee,
        wholeKwachaOnly: config.pricing.wholeKwachaOnly,
      });
    } catch {
      payouts.push({
        member: m.name,
        skipped: true,
        reason: "amount too small after fees",
      });
      continue;
    }

    const payout = await initiatePayout({
      amount: priced.netReceived,
      phone: m.phone,
      provider: providerFromPhone(m.phone || ""),
      statementDescription: "Chuma share out",
    });
    // Each member's savings are only zeroed by the settlement service once
    // THEIR payout reaches COMPLETED (the savings snapshot travels in meta).
    // A failed payout therefore leaves that member's stake untouched for a
    // retry, and the cycle fully resets when the last payout settles.
    //
    // A payout REJECTED at initiation never reaches PawaPay, so no callback
    // or reconciliation will ever finalise it — record it failed immediately
    // (making it retryable via retry-payout) and notify like any failure.
    const rejected = payout.status === "REJECTED";
    const txn = await Transaction.create({
      groupId: group._id,
      groupName: group.name,
      memberId: m.userId,
      memberName: m.name,
      type: "share-out",
      amount: calc.share, // full owed — what settlement decrements from the pool
      depositAmount: priced.netReceived, // what we actually sent to the member
      platformFee: priced.platformFee,
      status: rejected ? "failed" : payout.simulated ? "completed" : "pending",
      note: "Cycle share-out",
      receiptId: generateReceiptId("CHM"),
      pawapay: {
        payoutId: payout.id,
        status: payout.status,
        ...(rejected ? { failureReason: JSON.stringify(payout.error) } : {}),
      },
      meta: { memberSavings: m.savings },
    });
    if (txn.status === "completed") await settleCompletedTransaction(txn);
    else if (rejected) await handleFailedTransaction(txn);
    payouts.push({
      member: m.name,
      owed: calc.share,
      sent: priced.netReceived,
      fees: priced.totalFees,
      payoutId: payout.id,
    });
  }

  return { payouts, summary: result };
}

export default { distributeShareOut };
