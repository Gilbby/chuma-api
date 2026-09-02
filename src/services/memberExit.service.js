import { Transaction } from "../models/Transaction.js";
import { Loan } from "../models/Loan.js";
import { generateReceiptId } from "../utils/helpers.js";
import { initiatePayout, providerFromPhone } from "./pawapay.service.js";
import { pricePayout } from "./pricing.service.js";
import { config } from "../config/index.js";
import {
  settleCompletedTransaction,
  handleFailedTransaction,
} from "./settlement.service.js";

/**
 * Refund a removed member's stake and retire their member row.
 *
 * Removal is an EXIT, not a delete: the money in the pool is theirs and has to
 * come back to them. It runs in the same two legs as a share-out, for the same
 * reasons:
 *
 *   Leg A — any loan they still owe is cleared out of their own savings first
 *           (VSLA netting). No cash moves; the debt is offset against Leg B.
 *   Leg B — what is left is paid to their mobile wallet, and ONLY when that
 *           payout completes does the settlement service zero their savings and
 *           flip their row to "removed" (see the "withdrawal" branch there).
 *
 * Settling before removing is deliberate: a payout that fails leaves them a
 * member with their savings intact, never an ex-member the group still owes.
 *
 * Throws a 409 when the group's wallet cannot cover the refund — the caller
 * keeps the approval usable so admins can run it again once repayments land.
 */
export async function refundAndRemoveMember(group, member, { approvalId } = {}) {
  const savings = Math.max(0, member.savings || 0);

  const openLoans = await Loan.find({
    groupId: group._id,
    memberId: member.userId,
    status: { $in: ["active", "overdue"] },
  });
  const debt = openLoans.reduce((sum, l) => sum + (l.outstanding || 0), 0);

  // The payout draws on the merchant float, so refuse BEFORE any money moves or
  // any loan is netted — a blocked refund must leave the member exactly as it
  // found them. Netted debt needs no wallet cash, so only the cash that will
  // actually go out has to be covered.
  const wallet = group.walletBalance || 0;
  const projectedCash = Math.max(0, savings - Math.min(savings, debt));
  if (projectedCash > wallet) {
    const err = new Error(
      `Refund of K${projectedCash} exceeds the group wallet (K${wallet}). Collect repayments first, then approve the removal again.`
    );
    err.status = 409;
    throw err;
  }

  // Leg A — clear their own debt out of their own stake.
  let budget = savings;
  let appliedToLoan = 0;
  const netted = [];
  for (const loan of openLoans) {
    if (budget <= 0) break;
    const payAmount = Math.min(budget, loan.outstanding || 0);
    if (payAmount <= 0) continue;
    const repayTxn = await Transaction.create({
      groupId: group._id,
      groupName: group.name,
      memberId: member.userId,
      memberName: member.name,
      type: "repayment",
      amount: payAmount,
      status: "completed",
      note: "Loan cleared on removal from group",
      receiptId: generateReceiptId("CHR"),
      meta: { loanId: loan._id },
    });
    await settleCompletedTransaction(repayTxn);
    budget -= payAmount;
    appliedToLoan += payAmount;
    netted.push({ loanId: String(loan._id), applied: payAmount });
  }

  const cash = savings - appliedToLoan;

  const meta = {
    exit: true,
    memberRowId: member._id,
    memberSavings: savings,
    appliedToLoan,
    approvalId,
  };

  // Nothing left to send (no savings, or the whole stake cleared their loan).
  // Still book the exit so the settlement path — and only it — retires the row.
  if (cash <= 0) {
    const txn = await Transaction.create({
      groupId: group._id,
      groupName: group.name,
      memberId: member.userId,
      memberName: member.name,
      type: "withdrawal",
      amount: savings,
      depositAmount: 0,
      status: "completed",
      note: appliedToLoan > 0
        ? "Removal refund (fully applied to loan)"
        : "Removal from group (no savings to refund)",
      receiptId: generateReceiptId("CHM"),
      meta,
    });
    await settleCompletedTransaction(txn);
    return { refunded: 0, appliedToLoan, savings, netted, removed: true };
  }

  // Fees come out of what they receive, exactly as at share-out. pricePayout
  // THROWS when the fees meet or exceed the amount — a stake too small to send
  // must not strand the removal, so pay out nothing and retire the row.
  const correspondent = providerFromPhone(member.phone || "");
  let priced;
  try {
    priced = pricePayout({
      owed: cash,
      platformFee: config.pricing.platformFeeFor(cash),
      pawapayRate: config.pricing.payoutRateFor(correspondent),
      feesOnEndUser: config.pricing.feesOnEndUser,
      mnoFee: config.pricing.payoutLevyFor(correspondent),
      wholeKwachaOnly: config.pricing.wholeKwachaOnly,
    });
  } catch {
    const txn = await Transaction.create({
      groupId: group._id,
      groupName: group.name,
      memberId: member.userId,
      memberName: member.name,
      type: "withdrawal",
      amount: savings,
      depositAmount: 0,
      status: "completed",
      note: `Removal refund of K${cash} too small to send after fees`,
      receiptId: generateReceiptId("CHM"),
      meta,
    });
    await settleCompletedTransaction(txn);
    return {
      refunded: 0,
      appliedToLoan,
      savings,
      netted,
      removed: true,
      skipped: "amount too small after fees",
    };
  }

  const payout = await initiatePayout({
    amount: priced.netReceived,
    phone: member.phone,
    provider: correspondent,
    statementDescription: "Chuma refund",
    metadata: [{ fieldName: "groupId", fieldValue: String(group._id) }],
  });

  // A payout REJECTED at initiation never reaches PawaPay, so no callback or
  // reconciliation will finalise it — fail it now (retryable via retry-payout)
  // and leave the member in the group until the money actually lands.
  const rejected = payout.status === "REJECTED";
  const txn = await Transaction.create({
    groupId: group._id,
    groupName: group.name,
    memberId: member.userId,
    memberName: member.name,
    type: "withdrawal",
    amount: savings, // full stake — what settlement removes from the pool
    depositAmount: priced.netReceived, // what actually goes to their wallet
    platformFee: priced.platformFee,
    status: rejected ? "failed" : payout.simulated ? "completed" : "pending",
    note: "Refund on removal from group",
    receiptId: generateReceiptId("CHM"),
    pawapay: {
      transfers: payout.transfers, // ≥1 transfer; parent settles when all COMPLETE
      status: payout.status,
    },
    meta,
  });

  if (txn.status === "completed") await settleCompletedTransaction(txn);
  else if (rejected) await handleFailedTransaction(txn);

  return {
    refunded: priced.netReceived,
    fees: priced.totalFees,
    appliedToLoan,
    savings,
    netted,
    removed: txn.status === "completed",
    pending: txn.status === "pending",
    failed: rejected,
    payoutId: payout.transfers[0]?.payoutId,
    transactionId: txn._id,
  };
}

export default { refundAndRemoveMember };
