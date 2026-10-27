/**
 * Church cash flow - where a project-fund group's money is.
 *
 * Mobile money is on hold for member money, so church giving reaches the group
 * outside the app, and the app keeps the record:
 *
 *   1. The member gives and says how: cash handed to the treasurer, or a
 *      transfer straight into the church's bank / mobile-money account
 *      (checkout `channel`). It is pending.
 *   2. The cash handler confirms it arrived (a "cash-receipt" approval). It is
 *      settled: the member's receipt is final and the project has raised it.
 *      A transfer has now landed where it belongs. Cash has not - it is in the
 *      cash handler's hands.
 *   3. Later, and separately, the cash handler declares where that cash went:
 *      banked, put on mobile money, or paid out for a project (a CashDelivery).
 *
 * Money is kept in piles - one per project, plus "General giving" for giving
 * that named none - and each pile always balances:
 *
 *   raised = cashOnHand + banked + mobileMoney + paidOut
 *
 * Bank and mobile money are final: nothing records money leaving the church
 * accounts, so only cash still in hand can be paid out. A project's cash pays
 * only for that project; General giving can pay for any, which is counted as
 * spent on the project (paidFromGeneral), never as raised for it.
 *
 * Everything here is derived from settled transactions and deliveries rather
 * than kept as running balances, so it can never drift from the ledger.
 */
import mongoose from "mongoose";
import { Transaction } from "../models/Transaction.js";
import { CashDelivery } from "../models/CashDelivery.js";
import { isProjectFundGroup } from "./logic.service.js";
import { notifyAll } from "./notify.service.js";

export const GENERAL_GIVING_LABEL = "General giving";
export const GIVING_CHANNELS = ["cash", "bank", "mobile-money"];
const DESTINATIONS = ["bank", "mobile-money", "project"];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// Sums of 2dp amounts pick up float dust; anything smaller than this is zero.
const EPSILON = 0.005;

/**
 * Whose job a church group's cash is: the Treasurer's, and the Chairperson's
 * only when the group has no active Treasurer. The same rule raiseCashReceipt
 * uses to address a receipt, so whoever confirms cash arrived is the one who
 * later says where it went.
 */
export function cashHandlerRole(group) {
  const hasTreasurer = (group.members || []).some(
    (m) => m.status === "active" && m.role === "Treasurer"
  );
  return hasTreasurer ? "Treasurer" : "Chairperson";
}

export function handlesCash(group, member) {
  return (
    isProjectFundGroup(group) &&
    member?.status === "active" &&
    member.role === cashHandlerRole(group)
  );
}

/**
 * The giving in one settled transaction: how much, which pile, and where it
 * landed. Before members said how they paid, a manual payment was cash and
 * anything else came in by mobile money.
 */
function givingOf(t) {
  const m = t.meta || {};
  const amount =
    t.type === "contribution"
      ? Math.abs(Number(t.amount) || 0)
      : (Number(m.contribution) || 0) + (Number(m.topup) || 0);
  const channel = GIVING_CHANNELS.includes(m.channel)
    ? m.channel
    : t.paymentMethod === "Cash"
      ? "cash"
      : t.paymentMethod === "Bank Transfer"
        ? "bank"
        : "mobile-money";
  return { amount, channel, projectId: m.projectId ? String(m.projectId) : null };
}

/**
 * Where a project-fund group's money is, pile by pile, plus its most recent
 * deliveries (newest first).
 */
export async function computeGroupFunds(group, { deliveryLimit = 20 } = {}) {
  const [txns, deliveries] = await Promise.all([
    Transaction.find({
      groupId: group._id,
      status: "completed",
      type: { $in: ["contribution", "combined"] },
    })
      .select("type amount meta paymentMethod")
      .lean(),
    CashDelivery.find({ groupId: group._id }).sort({ date: -1, _id: -1 }).lean(),
  ]);

  const projects = group.projects || [];
  const nameOf = (id) =>
    id
      ? projects.find((p) => String(p._id) === String(id))?.name ?? "Project"
      : GENERAL_GIVING_LABEL;

  // Every project gets a pile, in the group's own order, so the screens can
  // match one to each project row; General giving goes last.
  const piles = new Map();
  const pile = (id) => {
    const key = id ? String(id) : "";
    if (!piles.has(key))
      piles.set(key, {
        projectId: id ? String(id) : null,
        name: nameOf(id),
        raised: 0,
        cashOnHand: 0,
        banked: 0,
        mobileMoney: 0,
        paidOut: 0,
        paidFromGeneral: 0,
      });
    return piles.get(key);
  };
  for (const p of projects) pile(p._id);
  pile(null);

  for (const t of txns) {
    const { amount, channel, projectId } = givingOf(t);
    if (!(amount > 0)) continue;
    const p = pile(projectId);
    p.raised += amount;
    if (channel === "cash") p.cashOnHand += amount;
    else if (channel === "bank") p.banked += amount;
    else p.mobileMoney += amount;
  }

  for (const d of deliveries) {
    const p = pile(d.sourceProjectId);
    p.cashOnHand -= d.amount;
    if (d.destination === "bank") p.banked += d.amount;
    else if (d.destination === "mobile-money") p.mobileMoney += d.amount;
    else {
      // Paid out: money that has left the church.
      p.paidOut += d.amount;
      if (!d.sourceProjectId && d.targetProjectId)
        pile(d.targetProjectId).paidFromGeneral += d.amount;
    }
  }

  return {
    piles: [...piles.values()].map((p) => ({
      ...p,
      raised: round2(p.raised),
      cashOnHand: round2(p.cashOnHand),
      banked: round2(p.banked),
      mobileMoney: round2(p.mobileMoney),
      paidOut: round2(p.paidOut),
      paidFromGeneral: round2(p.paidFromGeneral),
    })),
    deliveries: deliveries.slice(0, deliveryLimit).map((d) => shapeDelivery(d, nameOf)),
  };
}

function shapeDelivery(d, nameOf) {
  return {
    ...d,
    sourceName: nameOf(d.sourceProjectId),
    targetName: d.targetProjectId ? nameOf(d.targetProjectId) : null,
  };
}

// Per-group queue: each declaration waits for the one before it in the same
// group to finish. Groups never wait on each other.
const groupQueues = new Map();
function withGroupLock(groupId, fn) {
  const key = String(groupId);
  const run = (groupQueues.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  groupQueues.set(key, tail);
  tail.then(() => {
    if (groupQueues.get(key) === tail) groupQueues.delete(key);
  });
  return run;
}

const cashOnHandOf = (funds, sourceProjectId) =>
  funds.piles.find((p) => p.projectId === (sourceProjectId ? String(sourceProjectId) : null))
    ?.cashOnHand ?? 0;

/**
 * Record that held cash went somewhere. Returns { delivery, deliveries, funds }
 * or { error, status } to hand back.
 *
 * Body: { sourceProjectId (null = General giving), destination, amount,
 *         targetProjectId? (destination "project"), reference?, payee? }
 *    or { all: true, destination, targetProjectId?, reference?, payee? }
 *
 * `all` pays out every kwacha in hand at once - one deposit slip for the lot,
 * to the bank or mobile money - recorded as one delivery per pile, sharing a
 * batchId, so every project's figures stay right. It never pays a project:
 * money is spent on a project from that project's own pile.
 */
export async function recordDelivery({ group, member, user, body }) {
  if (!isProjectFundGroup(group))
    return { status: 400, error: "Only church groups track where their cash went" };
  if (!handlesCash(group, member))
    return {
      status: 403,
      error:
        cashHandlerRole(group) === "Treasurer"
          ? "Only the treasurer declares where the group's cash went"
          : "This group has no treasurer, so only the chairperson declares where its cash went",
    };

  const destination = body?.destination;
  if (!DESTINATIONS.includes(destination))
    return { status: 400, error: "Say where the money went" };

  const all = body?.all === true;
  if (all && destination === "project")
    return {
      status: 400,
      error: "Paying out everything at once goes to the bank or mobile money. Pay a project from its own row.",
    };
  const amount = all ? null : round2(body?.amount);
  if (!all && !(amount > 0)) return { status: 400, error: "Enter the amount" };

  const findProject = (id) =>
    id && mongoose.isValidObjectId(id)
      ? group.projects.find((p) => String(p._id) === String(id))
      : null;

  const sourceProjectId = all ? null : body?.sourceProjectId || null;
  const source = sourceProjectId ? findProject(sourceProjectId) : null;
  if (sourceProjectId && !source)
    return { status: 400, error: "That project no longer exists" };
  const sourceName = source?.name ?? GENERAL_GIVING_LABEL;

  let target = null;
  let payee;
  const reference = String(body?.reference ?? "").trim().slice(0, 60) || undefined;

  if (destination === "project") {
    if (source) {
      // A project's cash was given toward that project; it pays for nothing else.
      if (body?.targetProjectId && String(body.targetProjectId) !== String(source._id))
        return {
          status: 400,
          error: `${source.name} cash can only be paid out for ${source.name}`,
        };
      target = source;
    } else if (body?.targetProjectId) {
      // General giving was given toward nothing in particular: naming the
      // project it paid for is optional, and a payout that names none is
      // simply paid out of General giving.
      target = findProject(body.targetProjectId);
      if (!target) return { status: 400, error: "That project no longer exists" };
      if (target.status === "archived")
        return { status: 400, error: "That project is closed" };
    }
    payee = String(body?.payee ?? "").trim().slice(0, 80);
    if (payee.length < 2) return { status: 400, error: "Say who was paid" };
  }
  // The reference (deposit slip, transaction ID, receipt number) is optional:
  // what makes a payout a record is that it says where the money went, and
  // that is on the group statement either way.

  // Check-then-write, one group at a time: a double-tapped Confirm must record
  // the payout once and refuse the second as overdrawn, not race itself.
  const written = await withGroupLock(group._id, async () => {
    const before = await computeGroupFunds(group);

    // What leaves which pile.
    let legs;
    if (all) {
      legs = before.piles
        .filter((p) => p.cashOnHand > EPSILON)
        .map((p) => ({ projectId: p.projectId, name: p.name, amount: p.cashOnHand }));
      if (!legs.length) return { status: 400, error: "You are not holding any cash" };
    } else {
      const held = cashOnHandOf(before, source?._id);
      if (amount > held + EPSILON)
        return {
          status: 400,
          error: `You are holding K${round2(held)} of ${sourceName} cash`,
        };
      legs = [{ projectId: source ? String(source._id) : null, name: sourceName, amount }];
    }

    const batchId = legs.length > 1 ? new mongoose.Types.ObjectId() : undefined;
    const created = await CashDelivery.insertMany(
      legs.map((l) => ({
        groupId: group._id,
        sourceProjectId: l.projectId,
        destination,
        targetProjectId: target?._id ?? null,
        amount: l.amount,
        reference,
        payee,
        batchId,
        recordedBy: user._id,
        recordedByName: user.name,
        recordedByRole: member.role,
      }))
    );

    // The lock covers one server. Should two ever run, two declarations could
    // still each see the cash in hand, so recount with these in: if a pile
    // went below zero, this declaration overdrew it and is taken back out.
    const funds = await computeGroupFunds(group);
    if (legs.some((l) => cashOnHandOf(funds, l.projectId) < -EPSILON)) {
      await CashDelivery.deleteMany({ _id: { $in: created.map((d) => d._id) } });
      return {
        status: 409,
        error: "Some of that cash was just paid out. Refresh and try again.",
      };
    }
    return { created, funds };
  });
  if (written.error) return written;
  const { created, funds } = written;
  const total = round2(created.reduce((sum, d) => sum + d.amount, 0));

  // Handing in cash is witnessed by the chairperson (see cashReceipt.service);
  // so is where it went, which nobody else sees either. In-app only.
  const chairs = (group.members || []).filter(
    (m) =>
      m.status === "active" &&
      m.userId &&
      m.role === "Chairperson" &&
      String(m.userId) !== String(user._id)
  );
  if (chairs.length) {
    const where =
      destination === "bank"
        ? "deposited it to the church bank account"
        : destination === "mobile-money"
          ? "deposited it to the church mobile money"
          : target
            ? `paid it out for ${target.name} (${payee})`
            : `paid it out (${payee})`;
    await notifyAll(
      chairs.map((m) => m.userId),
      {
        type: "governance",
        title: "Cash paid out",
        body: all
          ? `${user.name} took all K${total} of the cash they were holding and ${where}.`
          : `${user.name} took K${total} of ${sourceName} cash and ${where}.`,
        groupId: group._id,
        groupName: group.name,
      }
    );
  }

  const nameOf = (id) => (id ? findProject(id)?.name ?? "Project" : GENERAL_GIVING_LABEL);
  const deliveries = created.map((d) => shapeDelivery(d.toObject(), nameOf));
  return { delivery: deliveries[0], deliveries, amount: total, funds };
}

export default {
  GENERAL_GIVING_LABEL,
  GIVING_CHANNELS,
  cashHandlerRole,
  handlesCash,
  computeGroupFunds,
  recordDelivery,
};
