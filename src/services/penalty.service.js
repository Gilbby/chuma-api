import { Penalty } from "../models/Penalty.js";
import { notify } from "./notify.service.js";

/**
 * Create a penalty (and its member notification) for a violation.
 * Shared by the manual detect endpoint and the scheduled detection job so both
 * follow one identical code path.
 *
 * - Returns null if amount <= 0.
 * - When dueContext is provided, dedupes: if a penalty already exists for the
 *   same { groupId, memberId, violationType, dueContext }, returns null instead
 *   of issuing a duplicate for that period. Manual calls omit dueContext and are
 *   never deduped.
 */
export async function issuePenalty({
  group,
  member,
  violationType,
  reason,
  amount,
  dueContext,
  issuedBy,
}) {
  if (amount <= 0) return null;

  if (dueContext) {
    const existing = await Penalty.findOne({
      groupId: group._id,
      memberId: member.userId,
      violationType,
      dueContext,
    });
    if (existing) return null;
  }

  const penalty = await Penalty.create({
    groupId: group._id,
    groupName: group.name,
    memberId: member.userId,
    memberName: member.name,
    violationType,
    reason,
    amount,
    fundsDestination: group.constitution?.penaltyFundsDestination || "group-pool",
    dueContext,
    issuedBy: issuedBy?._id,
    issuedByName: issuedBy?.name,
  });

  if (member.userId) {
    await notify({
      userId: member.userId,
      type: "penalty",
      title: "Penalty issued",
      body: `A ${reason.toLowerCase()} penalty of K${amount} was issued by ${group.name}.`,
      groupId: group._id,
      groupName: group.name,
      penaltyId: penalty._id,
      penaltyAmount: amount,
      penaltyReason: reason,
      // A penalty is a debt they did not choose. Late notice compounds it,
      // since the rules keep charging while the app sits unopened.
      sms: true,
      smsText: `Chuma: A ${reason.toLowerCase()} penalty of K${amount} was issued by ${group.name}. Pay it in the app.`,
    });
  }

  return penalty;
}

export default { issuePenalty };
