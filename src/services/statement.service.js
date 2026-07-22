import { Transaction } from "../models/Transaction.js";
import { Group } from "../models/Group.js";
import { generateReceiptId } from "../utils/helpers.js";

/**
 * Member account statement — the bank-statement view of one member's money.
 *
 * The only real "account" a member holds is their SAVINGS in a group, so that
 * is what carries the running balance. Savings move exactly where
 * settlement.service.js moves them, and nowhere else:
 *
 *   contribution → + amount                       (creditMemberSavings)
 *   combined     → + (meta.contribution + topup)  (savings leg of one deposit)
 *   share-out    → − meta.memberSavings           (stake paid out, cycle resets)
 *
 * Loans, repayments, penalties and fees are real cash movements but touch no
 * savings figure, so they are reported separately under `activity` with their
 * own money-in/money-out totals rather than being folded into the balance.
 * Keeping the two apart is what lets `closingBalance` reconcile with the
 * member's savings shown everywhere else in the app.
 */

/** Savings effect of a settled transaction. Anything else is 0. */
export function savingsDelta(txn) {
  if (txn.status !== "completed") return 0;
  switch (txn.type) {
    case "contribution":
      return Math.abs(Number(txn.amount) || 0);
    case "combined":
      return (
        (Number(txn.meta?.contribution) || 0) + (Number(txn.meta?.topup) || 0)
      );
    case "share-out":
      return -(Number(txn.meta?.memberSavings) || 0);
    default:
      return 0;
  }
}

function describe(txn) {
  switch (txn.type) {
    case "contribution":
      return txn.contributionType === "topup"
        ? "Savings top-up"
        : "Cycle contribution";
    case "combined":
      return "Contribution (part of combined payment)";
    case "share-out":
      return "Cycle share-out — savings paid out";
    case "loan":
      return "Loan disbursed to you";
    case "repayment":
      return "Loan repayment";
    case "penalty":
      return "Penalty paid";
    case "fee":
      return "Group fee";
    case "withdrawal":
      return "Withdrawal";
    default:
      return txn.type;
  }
}

/**
 * Build a statement for `memberId` over [from, to], optionally scoped to one
 * group. `to` is inclusive of the whole day the caller passed.
 */
export async function buildStatement({ user, groupId, from, to }) {
  const memberId = user._id;
  const scope = groupId ? { groupId } : {};

  // Opening balance: every settled savings movement BEFORE the period. Only
  // the three savings-affecting types can contribute, so don't drag the rest
  // of the ledger out of Mongo to add zeroes.
  const priorTxns = await Transaction.find({
    memberId,
    ...scope,
    status: "completed",
    type: { $in: ["contribution", "combined", "share-out"] },
    date: { $lt: from },
  })
    .select("type amount status meta")
    .lean();
  const openingBalance = priorTxns.reduce((sum, t) => sum + savingsDelta(t), 0);

  // Everything inside the period, oldest first — a statement reads forwards.
  const txns = await Transaction.find({
    memberId,
    ...scope,
    date: { $gte: from, $lte: to },
  })
    .sort({ date: 1 })
    .limit(1000)
    .lean();

  let balance = openingBalance;
  let savingsIn = 0;
  let savingsOut = 0;
  const lines = [];
  const activity = [];
  const totals = { moneyIn: 0, moneyOut: 0, net: 0, pending: 0, byType: {} };

  for (const t of txns) {
    const id = String(t._id);
    const signed = Number(t.amount) || 0;
    const direction = signed >= 0 ? "in" : "out";
    const abs = Math.abs(signed);

    const delta = savingsDelta(t);
    if (delta !== 0) {
      balance += delta;
      if (delta > 0) savingsIn += delta;
      else savingsOut += -delta;
      lines.push({
        id,
        date: t.date,
        type: t.type,
        groupName: t.groupName ?? "",
        description: describe(t),
        note: t.note ?? "",
        delta,
        balance,
        status: t.status,
        receiptId: t.receiptId ?? null,
      });
    }

    activity.push({
      id,
      date: t.date,
      type: t.type,
      groupName: t.groupName ?? "",
      description: describe(t),
      note: t.note ?? "",
      amount: abs,
      direction,
      status: t.status,
      receiptId: t.receiptId ?? null,
    });

    if (t.status === "pending") {
      totals.pending += abs;
    } else if (t.status === "completed") {
      if (direction === "in") totals.moneyIn += abs;
      else totals.moneyOut += abs;
      const bucket = (totals.byType[t.type] ??= { count: 0, in: 0, out: 0 });
      bucket.count += 1;
      bucket[direction] += abs;
    }
  }
  totals.net = totals.moneyIn - totals.moneyOut;

  let group = null;
  if (groupId) {
    const g = await Group.findById(groupId).select("name members").lean();
    const me = g?.members?.find((m) => String(m.userId) === String(memberId));
    group = g
      ? { id: String(g._id), name: g.name, role: me?.role ?? "Member" }
      : null;
  }

  return {
    statementId: generateReceiptId("STM"),
    generatedAt: new Date(),
    period: { from, to },
    member: { name: user.name, phone: user.phone },
    group,
    openingBalance,
    closingBalance: balance,
    savingsIn,
    savingsOut,
    totals,
    lines,
    activity,
  };
}

export default { buildStatement, savingsDelta };
