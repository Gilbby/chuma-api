import express from "express";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { closedToNewMembers, relationTo } from "../services/logic.service.js";
import { findLink, groupSummary } from "../services/joinLink.service.js";

const router = express.Router();

const LINK_INVALID = {
  error: "This link isn't valid any more. Ask the group for a new one.",
  code: "link_invalid",
};

/**
 * GET /api/links/:code  (auth) - what a join link points at, for the app's
 * join screen. Signed-in only: the app holds on to the link through sign-in,
 * and "is this invitation for me" needs to know who is asking.
 *
 * Joining itself goes through the existing endpoints, which already enforce
 * every rule: an invite is accepted or declined with POST /groups/:id/accept
 * or /decline (they only act on the CALLER's own pending invite, which is what
 * makes a personal link useless to any other number), and a share link leads
 * to POST /groups/:id/join-request.
 */
router.get(
  "/:code",
  requireAuth,
  asyncHandler(async (req, res) => {
    const link = await findLink(req.params.code);
    if (!link) return res.status(404).json(LINK_INVALID);

    const { group } = link;
    if (link.kind === "expired")
      return res.status(410).json({
        error: `This link to ${group.name} has expired. Ask a group admin to share a new one.`,
        code: "link_expired",
        groupName: group.name,
      });

    if (link.kind === "invite") {
      const { member } = link;
      const forYou =
        (member.userId && String(member.userId) === String(req.userId)) ||
        (!!member.phone && member.phone === req.user.phone);
      return res.json({
        kind: "invite",
        group: groupSummary(group),
        invite: {
          role: member.role || "Member",
          invitedBy: member.invitedByName || null,
          forYou,
          // Enough for someone on the wrong account to recognise which of
          // their numbers it went to, without revealing the number itself.
          phoneEnding: forYou ? null : String(member.phone || "").slice(-3) || null,
        },
        relation: relationTo(group, req.user),
      });
    }

    res.json({
      kind: "group",
      group: groupSummary(group),
      relation: relationTo(group, req.user),
      closedToNewMembers: closedToNewMembers(group),
      expiresAt: group.shareLink.expiresAt,
    });
  })
);

export default router;
