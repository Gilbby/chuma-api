import mongoose from "mongoose";
import { Group } from "../models/Group.js";
import { asyncHandler } from "./error.js";

export const ADMIN_ROLES = ["Chairperson", "Treasurer", "Secretary"];

function resolveGroupId(req, source) {
  return req.params?.[source] ?? req.query?.[source] ?? req.body?.[source];
}

/** Find the caller's active member row in a group (doc or plain object). */
export function findActiveMember(group, userId) {
  return group.members.find(
    (m) => String(m.userId) === String(userId) && m.status === "active"
  );
}

export function isGroupAdmin(group, userId) {
  const member = findActiveMember(group, userId);
  return !!member && ADMIN_ROLES.includes(member.role);
}

/**
 * Require the caller to be an active member of the group identified by
 * `source` (a param/query/body field, e.g. "id" or "groupId").
 * Attaches req.group (mongoose doc) and req.member (their member subdoc).
 */
export function requireGroupMember(source = "id") {
  return asyncHandler(async (req, res, next) => {
    const groupId = resolveGroupId(req, source);
    if (!groupId || !mongoose.isValidObjectId(groupId))
      return res.status(400).json({ error: "Valid groupId required" });

    const group = await Group.findById(groupId);
    if (!group) return res.status(404).json({ error: "Group not found" });

    const member = findActiveMember(group, req.userId);
    if (!member)
      return res.status(403).json({ error: "Not a member of this group" });

    req.group = group;
    req.member = member;
    next();
  });
}

/**
 * Same as requireGroupMember, but the member must also hold an admin role
 * (Chairperson / Treasurer / Secretary).
 */
export function requireGroupAdmin(source = "id") {
  const memberCheck = requireGroupMember(source);
  return (req, res, next) =>
    memberCheck(req, res, (err) => {
      if (err) return next(err);
      if (!ADMIN_ROLES.includes(req.member.role))
        return res
          .status(403)
          .json({ error: "Requires a group admin (Chairperson, Treasurer or Secretary)" });
      next();
    });
}

export default { requireGroupMember, requireGroupAdmin, isGroupAdmin, findActiveMember, ADMIN_ROLES };
