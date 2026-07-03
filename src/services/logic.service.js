/**
 * Business logic — ported directly from the Chuma frontend services so the
 * backend produces identical numbers to what the app already shows.
 * Mirrors: shareOut.ts, loans.ts, groupFees.ts, trustScore.ts, penalties.ts,
 * groupStats.ts, approvals.ts
 */

import config from "../config/index.js";

// ─── SHARE-OUT (shareOut.ts) ────────────────────────────────────────────────

export function computeShareOut(members, totalProfit) {
  const totalSavings = members.reduce((s, m) => s + m.contribution, 0);
  const roundedProfit = Math.round(totalProfit);

  if (totalSavings <= 0 || roundedProfit <= 0) {
    return {
      members: members.map((m) => ({
        ...m,
        profitShare: 0,
        share: m.contribution,
        growthPct: 0,
      })),
      totalSavings,
      profit: Math.max(roundedProfit, 0),
      totalToDistribute: totalSavings + Math.max(roundedProfit, 0),
    };
  }

  const exact = members.map((m) => {
    const exactProfit = (m.contribution / totalSavings) * roundedProfit;
    return {
      ...m,
      exactProfit,
      floor: Math.floor(exactProfit),
      frac: exactProfit - Math.floor(exactProfit),
    };
  });

  const sumFloors = exact.reduce((s, e) => s + e.floor, 0);
  const remainder = roundedProfit - sumFloors;

  const byFrac = [...exact].sort((a, b) => b.frac - a.frac);
  const bonusIds = new Set();
  for (let i = 0; i < remainder && i < byFrac.length; i++) {
    bonusIds.add(byFrac[i].id);
  }

  const result = exact.map((e) => {
    const profitShare = e.floor + (bonusIds.has(e.id) ? 1 : 0);
    const share = e.contribution + profitShare;
    const growthPct =
      e.contribution > 0
        ? Number(((profitShare / e.contribution) * 100).toFixed(1))
        : 0;
    return {
      id: e.id,
      name: e.name,
      contribution: e.contribution,
      profitShare,
      share,
      growthPct,
    };
  });

  const distributedProfit = result.reduce((s, m) => s + m.profitShare, 0);

  return {
    members: result,
    totalSavings,
    profit: distributedProfit,
    totalToDistribute: totalSavings + distributedProfit,
  };
}

export function estimateGroupProfit(
  loanCirculation,
  loanInterestRate,
  cycleMonths,
  penaltyIncome = 0
) {
  const interest = loanCirculation * (loanInterestRate / 100) * cycleMonths;
  return Math.round(interest + penaltyIncome);
}

// ─── LOANS (loans.ts) ───────────────────────────────────────────────────────

export function getMaxLoan(memberSavings, loanMultiplier) {
  return Math.round(memberSavings * (loanMultiplier || 1));
}

export function getLoanInterest(principal, monthlyRatePct, months) {
  return Math.round(principal * (monthlyRatePct / 100) * months);
}

export function getLoanBreakdown(principal, monthlyRatePct, months) {
  const interest = getLoanInterest(principal, monthlyRatePct, months);
  const totalRepay = principal + interest;
  const monthlyInstallment = months > 0 ? Math.round(totalRepay / months) : 0;
  return { principal, interest, totalRepay, monthlyInstallment };
}

export function checkEligibility(principal, maxLoan) {
  if (principal <= 0) return { eligible: false, reason: "Enter a loan amount" };
  if (principal > maxLoan)
    return { eligible: false, reason: `Exceeds your limit of ${maxLoan}` };
  return { eligible: true };
}

// ─── GROUP FEES (groupFees.ts) ──────────────────────────────────────────────

export const GRACE_PERIOD_DAYS = config.rules.graceDays;

export function getMonthsOwed(group) {
  if (!group.feePaidThrough || !group.monthlyFee) return 0;
  const paidThrough = new Date(group.feePaidThrough);
  const now = new Date();
  if (isNaN(paidThrough.getTime())) return 0;
  if (now <= paidThrough) return 0;
  let months =
    (now.getFullYear() - paidThrough.getFullYear()) * 12 +
    (now.getMonth() - paidThrough.getMonth());
  if (now.getDate() >= paidThrough.getDate()) months += 1;
  return Math.max(0, months);
}

export function getAmountOwed(group) {
  return getMonthsOwed(group) * (group.monthlyFee ?? 0);
}

export function getGraceInfo(group) {
  if (!group.feePaidThrough || !group.monthlyFee) {
    return { status: "paid", daysIntoGrace: 0, daysLeft: GRACE_PERIOD_DAYS };
  }
  const paidThrough = new Date(group.feePaidThrough);
  const now = new Date();
  if (isNaN(paidThrough.getTime()) || now <= paidThrough) {
    return { status: "paid", daysIntoGrace: 0, daysLeft: GRACE_PERIOD_DAYS };
  }
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysOverdue = Math.floor((now.getTime() - paidThrough.getTime()) / msPerDay);
  if (daysOverdue <= GRACE_PERIOD_DAYS) {
    return {
      status: "grace",
      daysIntoGrace: daysOverdue,
      daysLeft: GRACE_PERIOD_DAYS - daysOverdue,
    };
  }
  return { status: "locked", daysIntoGrace: GRACE_PERIOD_DAYS, daysLeft: 0 };
}

export function isGroupLocked(group) {
  return getGraceInfo(group).status === "locked";
}

export function advancePaidThrough(group, monthsPaid) {
  const base = group.feePaidThrough ? new Date(group.feePaidThrough) : new Date();
  base.setMonth(base.getMonth() + monthsPaid);
  return base;
}

export function advanceContributionDate(date, frequency) {
  const d = new Date(date);
  if (frequency === "Weekly") d.setDate(d.getDate() + 7);
  else if (frequency === "Bi-weekly") d.setDate(d.getDate() + 14);
  else d.setMonth(d.getMonth() + 1); // Monthly (default)
  return d;
}

/**
 * Returns the userIds of active members who did NOT record a completed/pending
 * "cycle" contribution within [windowStart, windowEnd]. Pure — no side effects.
 * - Only type "contribution" with contributionType "cycle" counts (top-ups don't).
 * - "failed" transactions don't count as paid.
 * - Only members with status "active" and a userId are considered.
 * `transactions` is the list of that group's transactions (already fetched by caller).
 */
export function findLateContributors(group, transactions, windowStart, windowEnd) {
  const start = new Date(windowStart).getTime();
  const end = new Date(windowEnd).getTime();
  const paid = new Set();
  for (const t of transactions) {
    if (t.type !== "contribution") continue;
    if (t.contributionType !== "cycle") continue;
    if (t.status === "failed") continue;
    const td = new Date(t.date).getTime();
    if (td >= start && td <= end) paid.add(String(t.memberId));
  }
  return group.members
    .filter((m) => m.status === "active" && m.userId)
    .filter((m) => !paid.has(String(m.userId)))
    .map((m) => String(m.userId));
}

// ─── TRUST SCORE (trustScore.ts) ────────────────────────────────────────────

export function getTrustScore(member, penaltyCount = 0) {
  let score = 70;
  score += Math.min((member.contributions || 0) * 2, 25);
  if (member.loanActive && member.loanActive > 0) score -= 5;
  score -= penaltyCount * 6;
  return Math.max(0, Math.min(Math.round(score), 100));
}

export function getTrustBand(score) {
  if (score >= 80) return { label: "Excellent", band: "excellent" };
  if (score >= 60) return { label: "Good", band: "good" };
  if (score >= 40) return { label: "Fair", band: "fair" };
  return { label: "Needs improvement", band: "low" };
}

// ─── PENALTIES (penalties.ts) ───────────────────────────────────────────────

export function computePenaltyAmount(rule, baseAmount, daysLate) {
  if (!rule) return 0;
  if (rule.penaltyType === "flat" && rule.penaltyAmount) return rule.penaltyAmount;
  if (rule.amount && !rule.penaltyType) return rule.amount;
  if (rule.penaltyType === "percent" && rule.penaltyRate) {
    const raw = baseAmount * (rule.penaltyRate / 100) * Math.max(daysLate, 1);
    const cap = baseAmount * 0.3;
    return Math.round(Math.min(raw, cap));
  }
  return 0;
}

// ─── GROUP STATS (groupStats.ts) ────────────────────────────────────────────

export function getSavingsGrowth(group) {
  const t = group.trend;
  if (!t || t.length < 2) return group.savingsGrowth ?? 0;
  const latest = t[t.length - 1].value;
  const prev = t[t.length - 2].value;
  if (prev === 0) return 0;
  return Math.round(((latest - prev) / prev) * 100);
}

export function getRepaymentRate(group, loans) {
  const groupLoans = loans.filter(
    (l) => String(l.groupId) === String(group._id || group.id)
  );
  if (groupLoans.length === 0) return 100;
  const totalPrincipal = groupLoans.reduce((s, l) => s + l.principal, 0);
  const totalOutstanding = groupLoans.reduce((s, l) => s + l.outstanding, 0);
  if (totalPrincipal === 0) return 100;
  return Math.round(((totalPrincipal - totalOutstanding) / totalPrincipal) * 100);
}

export function getDefaults(group, loans) {
  const now = new Date();
  return loans.filter((l) => {
    if (String(l.groupId) !== String(group._id || group.id)) return false;
    if (l.status !== "active") return false;
    if (l.outstanding <= 0) return false;
    const due = new Date(l.nextDueDate);
    if (isNaN(due.getTime())) return false;
    return due.getTime() < now.getTime();
  }).length;
}

// ─── APPROVALS (approvals.ts) ───────────────────────────────────────────────

export function getRequiredApprovals(threshold, adminCount) {
  const admins = Math.max(adminCount, 1);
  switch (threshold) {
    case "2-of-3":
      return Math.min(2, admins);
    case "all":
      return admins;
    case "majority":
    default:
      return Math.floor(admins / 2) + 1;
  }
}

export function countAdmins(members) {
  return (members || []).filter((m) =>
    ["Chairperson", "Treasurer", "Secretary"].includes(m.role)
  ).length;
}

export default {
  computeShareOut,
  estimateGroupProfit,
  getMaxLoan,
  getLoanInterest,
  getLoanBreakdown,
  checkEligibility,
  getMonthsOwed,
  getAmountOwed,
  getGraceInfo,
  isGroupLocked,
  advancePaidThrough,
  advanceContributionDate,
  findLateContributors,
  getTrustScore,
  getTrustBand,
  computePenaltyAmount,
  getSavingsGrowth,
  getRepaymentRate,
  getDefaults,
  getRequiredApprovals,
  countAdmins,
};
