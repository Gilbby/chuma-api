import { Penalty } from "../models/Penalty.js";
import { Transaction } from "../models/Transaction.js";
import { generateReceiptId } from "../utils/helpers.js";
import { computeShareOut, estimateGroupProfit } from "./logic.service.js";
import { initiatePayout, providerFromPhone } from "./pawapay.service.js";

/**
 * Pays each active member their share of the group's pool via PawaPay payout,
 * records share-out Transactions, then resets the cycle (zeroes savings /
 * contributions / totalSavings / cycleProgress) and saves the group.
 */
export async function distributeShareOut(group) {
  const penaltyIncome = await Penalty.find({
    groupId: group._id,
    status: "paid",
    fundsDestination: "group-pool",
  }).then((ps) => ps.reduce((s, p) => s + p.amount, 0));

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

  // Pay each member their share
  const payouts = [];
  for (const m of activeMembers) {
    const calc = result.members.find(
      (r) => r.id === String(m.userId || m._id)
    );
    if (!calc || calc.share <= 0) continue;
    const payout = await initiatePayout({
      amount: calc.share,
      phone: m.phone,
      provider: providerFromPhone(m.phone || ""),
      statementDescription: "Chuma share-out",
    });
    await Transaction.create({
      groupId: group._id,
      groupName: group.name,
      memberId: m.userId,
      memberName: m.name,
      type: "share-out",
      amount: calc.share,
      status: payout.simulated ? "completed" : "pending",
      note: "Cycle share-out",
      receiptId: generateReceiptId("CHM"),
      pawapay: { payoutId: payout.id, status: payout.status },
    });
    payouts.push({ member: m.name, amount: calc.share, payoutId: payout.id });
  }

  // Reset cycle: zero member savings + group pool, start a new cycle
  group.members.forEach((m) => {
    m.savings = 0;
    m.contributions = 0;
  });
  group.totalSavings = 0;
  group.cycleProgress = 0;
  await group.save();

  return { payouts, summary: result };
}

export default { distributeShareOut };
