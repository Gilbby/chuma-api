/**
 * Chuma Plan billing (Google Play subscriptions via RevenueCat).
 *
 * Model: a chairperson (the group's founder, governance.chairpersonUserId)
 * holds at most one "chuma_plan" subscription. Its base plan sets how many
 * groups it covers (groups-1 / groups-3 / groups-5). The plan covers the
 * founder's OLDEST non-closed groups first, so a downgrade or a lapse locks the
 * newest groups and the long-running ones keep working.
 *
 * Coverage is written onto each group as feePaidThrough ("covered until"), so
 * the existing fee machinery - getGraceInfo / isGroupLocked / the fee-lock
 * reminder job - does the locking unchanged: covered-until passes -> grace
 * window (rules.graceDays) -> locked.
 *
 * The plan itself is only ever taken from RevenueCat's REST API (secret key),
 * never from the app or a webhook body, so a tampered client can't unlock
 * groups.
 */
import mongoose from "mongoose";
import { Group } from "../models/Group.js";
import { User } from "../models/User.js";
import { announceGroupActivated } from "./settlement.service.js";
import config from "../config/index.js";

const RC_API = "https://api.revenuecat.com/v1";
const DAY_MS = 24 * 60 * 60 * 1000;

export function playBillingEnabled() {
  return config.billing.playBillingEnabled;
}

/**
 * The order a founder's plan covers their groups in: groups they picked
 * (billing.preferredAt, most recent first), then the rest oldest first.
 */
export function coverageOrder(groups) {
  const t = (d) => (d ? new Date(d).getTime() : 0);
  return [...groups].sort((a, b) => {
    const pa = t(a.billing?.preferredAt);
    const pb = t(b.billing?.preferredAt);
    if (pa !== pb) return pb - pa; // picked groups first, latest pick first
    const ca = t(a.createdAt);
    const cb = t(b.createdAt);
    if (ca !== cb) return ca - cb; // then oldest first
    return String(a._id).localeCompare(String(b._id));
  });
}

/** Group cap for a Play base plan id ("groups-3" -> 3). Unknown -> 0. */
export function groupLimitFor(basePlanId) {
  return config.billing.tiers[basePlanId] ?? 0;
}

function latest(...dates) {
  const valid = dates
    .filter(Boolean)
    .map((d) => new Date(d))
    .filter((d) => !isNaN(d.getTime()));
  if (!valid.length) return undefined;
  return new Date(Math.max(...valid.map((d) => d.getTime())));
}

function earliest(...dates) {
  const valid = dates
    .filter(Boolean)
    .map((d) => new Date(d))
    .filter((d) => !isNaN(d.getTime()));
  if (!valid.length) return undefined;
  return new Date(Math.min(...valid.map((d) => d.getTime())));
}

export function isPlanActive(plan, now = new Date()) {
  return !!(
    plan &&
    plan.groupLimit > 0 &&
    plan.expiresAt &&
    new Date(plan.expiresAt) > now
  );
}

/**
 * Read the founder's entitlement from RevenueCat and turn it into our plan
 * shape. RevenueCat reports Play base-plan products either as
 * product_identifier "chuma_plan" + product_plan_identifier "groups-3", or as
 * the combined "chuma_plan:groups-3" - both are handled.
 */
async function fetchPlanFromRevenueCat(userId) {
  const key = config.billing.revenuecatSecretKey;
  if (!key) {
    const err = new Error("Billing is not configured (REVENUECAT_SECRET_API_KEY missing)");
    err.status = 503;
    throw err;
  }

  const res = await fetch(`${RC_API}/subscribers/${encodeURIComponent(String(userId))}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = new Error(`RevenueCat lookup failed (${res.status})`);
    err.status = 502;
    throw err;
  }
  const { subscriber } = await res.json();
  const ent = subscriber?.entitlements?.[config.billing.entitlement];
  if (!ent) return { groupLimit: 0, syncedAt: new Date() };

  const [productBase, planFromId] = String(ent.product_identifier || "").split(":");
  const subs = subscriber.subscriptions || {};
  const sub =
    subs[ent.product_identifier] ||
    subs[`${productBase}:${ent.product_plan_identifier || planFromId}`] ||
    subs[productBase] ||
    {};
  const basePlanId =
    ent.product_plan_identifier || planFromId || sub.product_plan_identifier;
  if (!groupLimitFor(basePlanId))
    // Paid but unrecognised: would leave a paying founder with 0 groups.
    // Surface it loudly rather than guess a tier.
    console.error(
      `[billing] user ${userId}: entitlement "${config.billing.entitlement}" has unknown plan`,
      { product_identifier: ent.product_identifier, basePlanId }
    );

  // During Play's billing grace period RevenueCat keeps the entitlement alive
  // until grace_period_expires_date - honour whichever is later.
  const expiresAt = latest(ent.expires_date, ent.grace_period_expires_date);

  return {
    groupLimit: groupLimitFor(basePlanId),
    basePlanId,
    productId: productBase,
    store: sub.store,
    expiresAt,
    willRenew: !sub.unsubscribe_detected_at && !sub.refunded_at,
    unsubscribedAt: sub.unsubscribe_detected_at
      ? new Date(sub.unsubscribe_detected_at)
      : undefined,
    syncedAt: new Date(),
  };
}

/**
 * Pull the latest plan for one user from RevenueCat, store it, and re-apply
 * coverage to their groups. Called after a purchase (POST /billing/sync) and
 * for every RevenueCat webhook.
 */
export async function syncUserPlan(userId) {
  if (!mongoose.isValidObjectId(userId)) return null; // anonymous RC ids etc.
  const exists = await User.exists({ _id: userId });
  if (!exists) return null;

  const plan = await fetchPlanFromRevenueCat(userId);
  await User.updateOne({ _id: userId }, { $set: { plan } });
  await recomputeCoverage(userId);
  return plan;
}

/**
 * Re-decide which of a founder's groups their plan covers and stamp each
 * group's feePaidThrough / status accordingly. Safe to call any time (it's
 * idempotent) and a no-op while Play billing is off.
 */
export async function recomputeCoverage(userId) {
  if (!playBillingEnabled() || !userId) return;

  const user = await User.findById(userId).select("plan").lean();
  const now = new Date();
  const plan = user?.plan;
  const limit = isPlanActive(plan, now) ? plan.groupLimit : 0;

  const groups = coverageOrder(
    await Group.find({
      "governance.chairpersonUserId": userId,
      status: { $ne: "closed" },
    }).select("status feePaidThrough monthlyFee billing createdAt")
  );

  let used = 0;
  for (const g of groups) {
    // A group its admins are voting to delete doesn't hold a slot - the
    // founder asked for it gone, so the plan moves on to their next group.
    // Left untouched; if the vote fails it's back to "active" and the
    // approval route recomputes, so it competes for a slot again.
    if (g.status === "deletion-pending") continue;
    const covered = used < limit;
    if (covered) used++;

    let legacy = g.billing?.legacyFreeUntil;
    const set = { "billing.coveredByPlan": covered };

    // A group that predates billing but was never given its free window
    // (the legacy-deadline script wasn't run, or ran before it existed) gets
    // one now rather than being treated as free forever.
    if (!covered && !legacy && !g.feePaidThrough && g.status !== "pending-payment") {
      legacy = new Date(now.getTime() + config.billing.legacyGraceDays * DAY_MS);
      set["billing.legacyFreeUntil"] = legacy;
    }

    let paidThrough;
    if (covered) {
      paidThrough = latest(plan.expiresAt, legacy);
    } else {
      // No longer covered: coverage stops now (or stays where it already
      // ended), but a pre-billing group keeps its free window.
      paidThrough = latest(
        g.feePaidThrough ? earliest(g.feePaidThrough, now) : undefined,
        legacy
      );
    }
    if (paidThrough) set.feePaidThrough = paidThrough;
    if (!g.monthlyFee) set.monthlyFee = config.rules.groupMonthlyFee;

    const activates =
      g.status === "pending-payment" && paidThrough && paidThrough > now;
    if (activates) set.status = "active";

    await Group.updateOne({ _id: g._id }, { $set: set });
    // Treasurer/secretary invites are held back while a group waits for its
    // first payment - send them now it has started.
    if (activates) await announceGroupActivated(g._id, { feeMessage: false });
  }
}

/**
 * Founder chooses this group to be covered first. If the plan is full, the
 * group that was last in line loses cover (and gets the normal grace period).
 * Returns false if it isn't one of their open groups.
 */
export async function preferGroup(userId, groupId) {
  if (!mongoose.isValidObjectId(groupId)) return false;
  const res = await Group.updateOne(
    {
      _id: groupId,
      "governance.chairpersonUserId": userId,
      status: { $ne: "closed" },
    },
    { $set: { "billing.preferredAt": new Date() } }
  );
  if (!res.matchedCount) return false;
  await recomputeCoverage(userId);
  return true;
}

/** What the app needs to render the plan screen. */
export async function planSummary(userId) {
  const enabled = playBillingEnabled();
  const user = await User.findById(userId).select("plan").lean();
  const groups = coverageOrder(
    await Group.find({
      "governance.chairpersonUserId": userId,
      status: { $ne: "closed" },
    })
      .select("name status billing feePaidThrough createdAt")
      .lean()
  ).filter((g) => g.status !== "deletion-pending"); // being deleted: holds no slot

  const plan = user?.plan || { groupLimit: 0 };
  return {
    enabled,
    plan: {
      active: isPlanActive(plan),
      groupLimit: plan.groupLimit || 0,
      basePlanId: plan.basePlanId || null,
      expiresAt: plan.expiresAt || null,
      willRenew: plan.willRenew ?? null,
    },
    groupsFounded: groups.length,
    groupsCovered: groups.filter((g) => g.billing?.coveredByPlan).length,
    groups: groups.map((g) => ({
      id: String(g._id),
      name: g.name,
      status: g.status,
      coveredByPlan: !!g.billing?.coveredByPlan,
      freeUntil: g.billing?.legacyFreeUntil || null,
      coveredUntil: g.feePaidThrough || null,
    })),
    tiers: config.billing.tiers,
    // Kwacha per 1 USD for the app's "about K…" estimate; null = don't show one.
    usdToZmwRate: config.billing.usdToZmwRate > 0 ? config.billing.usdToZmwRate : null,
    maxGroupsFounded: config.rules.maxGroupsFounded,
  };
}
