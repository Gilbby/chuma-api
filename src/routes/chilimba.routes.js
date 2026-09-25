import express from "express";
import { Group } from "../models/Group.js";
import { Approval } from "../models/Approval.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import {
  requireGroupMember,
  ADMIN_ROLES,
} from "../middleware/groupAuth.js";
import { getRequiredApprovals, isChilimbaGroup } from "../services/logic.service.js";
import {
  drawRotationOrder,
  rotationView,
  currentRecipient,
  rotationComplete,
} from "../services/chilimba.service.js";
import { notifyAll } from "../services/notify.service.js";

const router = express.Router();

// Refuse anything on this router for a group that is not a chilimba - the
// rotation only means something for a rotating-savings group.
function ensureChilimba(req, res) {
  if (!isChilimbaGroup(req.group)) {
    res.status(400).json({ error: "This group is not a chilimba" });
    return false;
  }
  return true;
}

/**
 * GET /api/chilimba/:groupId  (auth, member)
 * The rotation state for the client's Chilimba tab: whether the order is drawn,
 * which round is live, the pot, the recipient this round, and every member in
 * payout order with who has already received.
 */
router.get(
  "/:groupId",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    if (!ensureChilimba(req, res)) return;
    res.json({ groupId: String(req.group._id), rotation: rotationView(req.group) });
  })
);

/**
 * POST /api/chilimba/:groupId/draw  (auth, CHAIRPERSON only)
 * Draws the payout order at random and locks it. From here membership is frozen
 * (the invite route refuses new members) so the round count and the pot stay
 * consistent with the order everyone agreed to.
 *
 * The chairperson alone draws: fixing the order for the whole rotation is a
 * decision the group elected them to hold, and it can only be done once.
 */
router.post(
  "/:groupId/draw",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    if (!ensureChilimba(req, res)) return;
    if (req.member.role !== "Chairperson")
      return res
        .status(403)
        .json({ error: "Only the chairperson can draw the payout order" });

    // drawRotationOrder throws {status:400} if already drawn / too few members.
    const group = await drawRotationOrder(req.group);

    // Everyone learns the order at the same moment - it decides when each of
    // them gets the pool, so nobody should hear it second-hand.
    const members = group.members.filter((m) => m.status === "active" && m.userId);
    await notifyAll(
      members.map((m) => m.userId),
      {
        type: "governance",
        title: "Chilimba payout order drawn",
        body: `The payout order for ${group.name} has been drawn. Check your position in the app - the pool rotates in that order.`,
        groupId: group._id,
        groupName: group.name,
        sms: true,
        smsText: `Chuma: The ${group.name} chilimba payout order has been drawn. Open the app to see when it is your turn.`,
      }
    );

    res.status(201).json({ rotation: rotationView(group) });
  })
);

/**
 * POST /api/chilimba/:groupId/propose-payout  (auth, CHAIRPERSON only)
 * Proposes handing this round's whole pool to the member whose turn it is, as a
 * pending approval routed to the other admins. Only one pending payout at a
 * time. The recipient and pot are recomputed from live group state when the
 * approval executes, so this cannot pay the wrong round or a stale amount.
 */
router.post(
  "/:groupId/propose-payout",
  requireAuth,
  requireGroupMember("groupId"),
  asyncHandler(async (req, res) => {
    if (!ensureChilimba(req, res)) return;
    const group = req.group;
    if (req.member.role !== "Chairperson")
      return res
        .status(403)
        .json({ error: "Only the chairperson can start a payout" });

    if (!group.chilimba?.orderDrawn)
      return res
        .status(400)
        .json({ error: "Draw the payout order before paying anyone out" });
    if (rotationComplete(group))
      return res.status(400).json({
        error: "Every member has already received - this chilimba is complete",
      });

    const existing = await Approval.exists({
      groupId: group._id,
      type: "chilimba-payout",
      status: "pending",
    });
    if (existing)
      return res.status(400).json({ error: "A payout is already pending" });

    const recipient = currentRecipient(group);
    if (!recipient)
      return res
        .status(400)
        .json({ error: "No member is due to receive this round" });

    // The pot is whatever has actually been collected into the group's wallet
    // this round. Nothing to hand out until members have contributed.
    const pool = group.walletBalance || 0;
    if (pool <= 0)
      return res.status(400).json({
        error:
          "Nothing has been collected for this round yet. Members need to contribute first.",
      });

    // Counted over ACTIVE admins, at the group's chosen threshold. An invited
    // admin who has not accepted cannot vote, so counting them would set a bar
    // the group can never reach.
    const activeAdmins = group.members.filter(
      (m) => m.status === "active" && ADMIN_ROLES.includes(m.role)
    );
    const required = getRequiredApprovals(
      group.constitution?.approvalThreshold || "majority",
      activeAdmins.length
    );

    const approval = await Approval.create({
      groupId: group._id,
      groupName: group.name,
      type: "chilimba-payout",
      title: `Chilimba payout - round ${group.chilimba.currentRound}`,
      description: `Approve handing this round's pool of K${pool} to ${recipient.name} (round ${group.chilimba.currentRound} of ${group.chilimba.totalRounds}).`,
      amount: pool,
      requestedById: req.userId,
      requestedBy: req.user.name,
      requiredApprovals: required,
      targetUserId: recipient.userId,
      targetName: recipient.name,
    });

    // Everyone whose approval is still needed - not the chairperson, who is the
    // one asking.
    const toAsk = activeAdmins.filter(
      (m) => String(m.userId) !== String(req.userId)
    );
    await notifyAll(
      toAsk.map((a) => a.userId),
      {
        type: "governance",
        title: "Chilimba payout approval needed",
        body: `${req.user.name} proposed paying this round's K${pool} pool to ${recipient.name} in ${group.name}. Your approval is needed.`,
        groupId: group._id,
        groupName: group.name,
        sms: true,
        smsText: `Chuma: ${req.user.name} proposed a K${pool} chilimba payout to ${recipient.name} in ${group.name}. Vote in the app.`,
      }
    );

    res.status(201).json({ approval });
  })
);

export default router;
