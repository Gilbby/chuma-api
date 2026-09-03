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

/** What each leg of a payment is called on the statement. */
const PURPOSE_LABELS = {
  contribution: "Savings contributions",
  topup: "Savings top-ups",
  repayment: "Loan repayments",
  penalty: "Penalties",
  fee: "Group fees",
  loan: "Loan disbursed to you",
  "savings-returned": "Your savings returned",
  "profit-share": "Profit share",
  withdrawal: "Withdrawal",
  other: "Other",
};

/** Display order within each side of the breakdown. */
const PURPOSE_ORDER = [
  "contribution",
  "topup",
  "repayment",
  "penalty",
  "fee",
  "loan",
  "savings-returned",
  "profit-share",
  "withdrawal",
  "other",
];

const TOLERANCE = 0.005; // sub-ngwee drift is rounding, not a missing leg

/**
 * What one settled transaction actually paid FOR, split into its legs.
 *
 * A statement that says "money out K15,000" is a number, not an account: the
 * member paid one lump and cannot see that K14,860 of it became savings and
 * K140 cleared a penalty. Two types are lumps and get taken apart here —
 * everything else is already one purpose.
 *
 * Every leg is a positive magnitude, and the legs of a transaction always sum
 * to |amount|. That invariant is the whole point: the itemisation has to add up
 * to the total printed under it, or it is worse than no itemisation at all. Any
 * transaction whose meta disagrees with what was charged falls back to a single
 * "other" leg rather than printing legs that do not reconcile.
 */
export function purposeLegs(txn) {
  const m = txn.meta || {};
  const abs = Math.abs(Number(txn.amount) || 0);
  if (abs <= 0) return [];

  switch (txn.type) {
    case "contribution":
      return [
        {
          key: txn.contributionType === "topup" ? "topup" : "contribution",
          amount: abs,
        },
      ];

    case "combined": {
      // One deposit settling several obligations. meta carries the savings and
      // loan legs outright; penalties are the remainder, because only their ids
      // are stored — payment.routes.js builds the charge as
      // contribution + topup + repayments + penalties.
      const savings = (Number(m.contribution) || 0) + (Number(m.topup) || 0);
      const repay = (m.repayments || []).reduce(
        (sum, r) => sum + (Number(r?.amount) || 0),
        0
      );
      const penalties = abs - savings - repay;
      if (savings < 0 || repay < 0 || penalties < -TOLERANCE)
        return [{ key: "other", amount: abs }];

      const legs = [];
      if (savings > 0) legs.push({ key: "contribution", amount: savings });
      if (repay > 0) legs.push({ key: "repayment", amount: repay });
      if (penalties > TOLERANCE) legs.push({ key: "penalty", amount: penalties });
      return legs.length ? legs : [{ key: "other", amount: abs }];
    }

    case "share-out": {
      // The payout is the member's own stake back, plus what the cycle earned
      // on it. Only the stake was ever in their savings balance, which is why
      // the two lines differ from each other and from the savings ledger.
      const stake = Math.min(Math.max(0, Number(m.memberSavings) || 0), abs);
      const profit = abs - stake;
      const legs = [];
      if (stake > 0) legs.push({ key: "savings-returned", amount: stake });
      if (profit > TOLERANCE) legs.push({ key: "profit-share", amount: profit });
      return legs.length ? legs : [{ key: "savings-returned", amount: abs }];
    }

    default:
      return [{ key: txn.type, amount: abs }];
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
  const byPurpose = { in: {}, out: {} };

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

      for (const leg of purposeLegs(t)) {
        const side = byPurpose[direction];
        const row = (side[leg.key] ??= {
          key: leg.key,
          label: PURPOSE_LABELS[leg.key] ?? leg.key,
          amount: 0,
          count: 0,
        });
        row.amount += leg.amount;
        row.count += 1;
      }
    }
  }
  totals.net = totals.moneyIn - totals.moneyOut;

  // Round for display, then make the rows tie to the total they sit under. Any
  // residue left by rounding becomes an explicit "Other" line rather than a
  // column that silently fails to add up.
  const side = (map, total) => {
    const rows = Object.values(map)
      .map((r) => ({ ...r, amount: Math.round(r.amount * 100) / 100 }))
      .filter((r) => r.amount > 0)
      .sort(
        (a, b) => PURPOSE_ORDER.indexOf(a.key) - PURPOSE_ORDER.indexOf(b.key)
      );
    const summed = rows.reduce((sum, r) => sum + r.amount, 0);
    const residue = Math.round((total - summed) * 100) / 100;
    if (Math.abs(residue) >= 0.01)
      rows.push({
        key: "other",
        label: PURPOSE_LABELS.other,
        amount: residue,
        count: 0,
      });
    return rows;
  };
  const breakdown = {
    in: side(byPurpose.in, totals.moneyIn),
    out: side(byPurpose.out, totals.moneyOut),
  };

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
    breakdown,
    lines,
    activity,
  };
}

export default { buildStatement, savingsDelta, purposeLegs };
