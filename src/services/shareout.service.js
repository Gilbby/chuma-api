import { Penalty } from "../models/Penalty.js";
import { Transaction } from "../models/Transaction.js";
import { Loan } from "../models/Loan.js";
import { generateReceiptId } from "../utils/helpers.js";
import {
  computeShareOut,
  estimateGroupProfit,
  computeLoanNetting,
} from "./logic.service.js";
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

  // Any loan still open at share-out is NETTED against the borrower's share:
  // their distribution pays it off first (VSLA "cancel shares equal to the
  // debt"), so the group never deadlocks waiting on a not-yet-due loan.
  const openLoans = await Loan.find({
    groupId: group._id,
    status: { $in: ["active", "overdue"] },
  });
  const loansByMember = new Map(); // memberId → [loans]
  for (const l of openLoans) {
    const key = String(l.memberId);
    if (!loansByMember.has(key)) loansByMember.set(key, []);
    loansByMember.get(key).push(l);
  }
  const debtFor = (id) =>
    (loansByMember.get(id) || []).reduce((s, l) => s + (l.outstanding || 0), 0);

  // What each member actually receives after netting their own debt.
  const { members: nettedMembers, totalNetCash } = computeLoanNetting(
    result.members,
    openLoans
  );
  const netCashById = new Map(nettedMembers.map((m) => [m.id, m.netPayout]));

  // Payouts draw real money from the merchant float. Because netted loans no
  // longer need wallet cash, we only require the wallet to cover the NET cash
  // going out — not the gross pot. Refuse BEFORE any payout goes out; status
  // 409 lets callers keep the approval usable for later.
  const wallet = group.walletBalance || 0;
  if (totalNetCash > wallet) {
    const err = new Error(
      `Net share-out of K${totalNetCash} (after loan netting) exceeds the group wallet (K${wallet}). Collect more repayments first, then distribute again.`
    );
    err.status = 409;
    throw err;
  }

  // Leg A — repay each open loan out of the borrower's share, reusing the
  // tested repayment settlement (decrements loanCirculation, marks the loan
  // repaid). No real cash moves; the debt is offset against the payout below.
  const netted = [];
  for (const m of activeMembers) {
    const id = String(m.userId || m._id);
    let budget = Math.min(
      result.members.find((r) => r.id === id)?.share ?? 0,
      debtFor(id)
    );
    for (const loan of loansByMember.get(id) || []) {
      if (budget <= 0) break;
      const payAmount = Math.min(budget, loan.outstanding || 0);
      if (payAmount <= 0) continue;
      const repayTxn = await Transaction.create({
        groupId: group._id,
        groupName: group.name,
        memberId: m.userId,
        memberName: m.name,
        type: "repayment",
        amount: payAmount,
        status: "completed",
        note: "Loan cleared from share-out",
        receiptId: generateReceiptId("CHR"),
        meta: { loanId: loan._id },
      });
      await settleCompletedTransaction(repayTxn);
      budget -= payAmount;
      netted.push({ member: m.name, loanId: String(loan._id), applied: payAmount });
    }
  }

  // Leg B — pay each member their share. The share-out transaction still books
  // the FULL owed share (savings + profit) so savings reset correctly; Leg A
  // already returned the netted cash to the wallet, so the two net to the cash
  // we actually send (share − debt).
  const payouts = [];
  for (const m of activeMembers) {
    const calc = result.members.find(
      (r) => r.id === String(m.userId || m._id)
    );
    if (!calc || calc.share <= 0) continue;
    const netCash = netCashById.get(calc.id) ?? calc.share;

    // Whole share went to the member's loan — nothing to send. Still record the
    // share-out (completed) so their savings reset and the cycle can close.
    if (netCash <= 0) {
      const txn = await Transaction.create({
        groupId: group._id,
        groupName: group.name,
        memberId: m.userId,
        memberName: m.name,
        type: "share-out",
        amount: calc.share,
        depositAmount: 0,
        status: "completed",
        note: "Cycle share-out (fully applied to loan)",
        receiptId: generateReceiptId("CHM"),
        meta: { memberSavings: m.savings },
      });
      await settleCompletedTransaction(txn);
      payouts.push({ member: m.name, owed: calc.share, sent: 0, appliedToLoan: calc.share });
      continue;
    }

    // Deduct fees (PawaPay % + MNO + platform fee) from what the member NETS
    // after loan netting. pricePayout THROWS when the fees meet or exceed the
    // amount (tiny stakes) — skip that member rather than crash the share-out.
    let priced;
    try {
      priced = pricePayout({
        owed: netCash,
        platformFee: config.pricing.platformFeeFor(netCash), // our 1% platform
        pawapayRate: config.pricing.payoutRateFor(providerFromPhone(m.phone || "")), // 1% Airtel / 2% MTN
        feesOnEndUser: config.pricing.feesOnEndUser,
        mnoFee: config.pricing.payoutLevyFor(providerFromPhone(m.phone || "")), // 0 Airtel / e-levy MTN
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
        transfers: payout.transfers, // ≥1 transfer; parent settles when all COMPLETE
        status: payout.status,
      },
      meta: { memberSavings: m.savings },
    });
    if (txn.status === "completed") await settleCompletedTransaction(txn);
    else if (rejected) await handleFailedTransaction(txn);
    payouts.push({
      member: m.name,
      owed: calc.share,
      appliedToLoan: calc.share - netCash,
      sent: priced.netReceived,
      fees: priced.totalFees,
      payoutId: payout.transfers[0]?.payoutId,
      transfers: payout.transfers.length,
    });
  }

  return { payouts, netted, summary: result };
}

export default { distributeShareOut };
