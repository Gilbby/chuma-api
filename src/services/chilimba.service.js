/**
 * Chilimba (rotating savings / ROSCA) rotation logic.
 *
 * A chilimba pays the WHOLE pool to one member each round, in a fixed order
 * that is drawn at random once and then locked, until every member has received
 * exactly once. This is the opposite of a share-out (which splits the pool
 * across everyone proportionally at the end of a cycle): here each round is a
 * mini-cycle that fills up from contributions and empties to a single recipient.
 *
 * The order lives on the member subdocs (`payoutPosition`, 1-based) and the
 * round pointer on `group.chilimba` - see Group.js and CHILIMBA_TYPES in
 * logic.service.js. Money effects (emptying the pool, marking the recipient,
 * advancing the round) are applied by the settlement service's
 * "chilimba-payout" case, the one place payment side effects belong.
 */

/** Active members of a chilimba group (the ones the rotation is drawn over). */
export function activeChilimbaMembers(group) {
  return (group.members || []).filter((m) => m.status === "active" && m.userId);
}

/**
 * The expected pool for one round: the agreed contribution times the number of
 * members in the rotation. This is the target - what everyone SHOULD have paid
 * in - and is what the app shows as "the pot". The amount actually paid out is
 * whatever has really been collected (the group's wallet), which equals this
 * once every member has contributed for the round.
 */
export function expectedPool(group) {
  const count = activeChilimbaMembers(group).length;
  return Math.round((group.contributionAmount || 0) * count);
}

/** The member whose turn it is this round (payoutPosition === currentRound). */
export function currentRecipient(group) {
  const round = group.chilimba?.currentRound;
  if (!round) return null;
  return (
    activeChilimbaMembers(group).find((m) => m.payoutPosition === round) || null
  );
}

/** True once every round has been paid out (the rotation is complete). */
export function rotationComplete(group) {
  const c = group.chilimba;
  return !!c?.orderDrawn && c.currentRound > (c.totalRounds || 0);
}

/**
 * Draw the payout order at random and lock it. Assigns every active member a
 * 1-based `payoutPosition`, records the draw on `group.chilimba`, and opens
 * round 1. Membership is frozen from here on (the invite route refuses new
 * members once `orderDrawn`), so `totalRounds` stays consistent with the order.
 *
 * Mutates and SAVES the given group document. Throws (status 400) when the
 * order is already drawn or there are too few members to rotate.
 */
export async function drawRotationOrder(group) {
  if (group.chilimba?.orderDrawn) {
    const err = new Error("The payout order has already been drawn");
    err.status = 400;
    throw err;
  }
  const members = activeChilimbaMembers(group);
  if (members.length < 2) {
    const err = new Error(
      "A chilimba needs at least two active members before drawing the payout order"
    );
    err.status = 400;
    throw err;
  }

  // Fisher-Yates shuffle over a copy of the active member row ids, then assign
  // positions back onto the subdocs. Shuffling ids (not the subdoc array) keeps
  // Mongoose change tracking simple - we only touch payoutPosition.
  const ids = members.map((m) => String(m._id));
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  ids.forEach((id, index) => {
    const member = group.members.id(id);
    if (member) {
      member.payoutPosition = index + 1;
      member.payoutReceived = false;
      member.payoutRound = undefined;
      member.payoutReceivedAt = undefined;
    }
  });

  group.chilimba = {
    orderDrawn: true,
    orderDrawnAt: new Date(),
    currentRound: 1,
    totalRounds: members.length,
  };
  await group.save();
  return group;
}

/**
 * A serialisable view of the rotation for the client: whether the order is
 * drawn, which round is live, the pot (expected and actually collected), the
 * recipient this round, and every member in payout order with their status.
 */
export function rotationView(group) {
  const c = group.chilimba || {};
  const recipient = currentRecipient(group);
  const order = activeChilimbaMembers(group)
    .filter((m) => m.payoutPosition != null)
    .sort((a, b) => a.payoutPosition - b.payoutPosition)
    .map((m) => ({
      userId: String(m.userId),
      name: m.name,
      position: m.payoutPosition,
      received: !!m.payoutReceived,
      round: m.payoutRound ?? null,
      receivedAt: m.payoutReceivedAt ?? null,
      isCurrent: recipient ? String(m.userId) === String(recipient.userId) : false,
    }));

  return {
    orderDrawn: !!c.orderDrawn,
    orderDrawnAt: c.orderDrawnAt ?? null,
    currentRound: c.currentRound || 0,
    totalRounds: c.totalRounds ?? activeChilimbaMembers(group).length,
    complete: rotationComplete(group),
    expectedPool: expectedPool(group),
    collectedPool: group.walletBalance || 0,
    currentRecipient: recipient
      ? { userId: String(recipient.userId), name: recipient.name }
      : null,
    order,
  };
}

export default {
  activeChilimbaMembers,
  expectedPool,
  currentRecipient,
  rotationComplete,
  drawRotationOrder,
  rotationView,
};
