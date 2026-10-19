import crypto from "crypto";
import { Group } from "../models/Group.js";
import config from "../config/index.js";

/**
 * Join links: <config.links.joinBaseUrl>/join/<code>.
 *
 * Two kinds share the one /join/<code> address:
 *  - a personal invite link: members[].inviteCode on a PENDING member row. Only
 *    the invited number can accept through it, and it dies with the invite
 *    (accepted, declined or withdrawn all remove the pending row).
 *  - a group share link: group.shareLink. Anyone who opens it can ask to join,
 *    and an admin approves the request as usual. It expires after
 *    config.links.shareLinkDays; an admin can reset it to kill the old code.
 *
 * Both codes are admin-only data: withFeeStatus strips them from group payloads.
 */

// No 0/O, 1/l/I: a code is sometimes read out or typed from a screenshot.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const CODE_LENGTH = 10;
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

export function newLinkCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return code;
}

/** Cheap shape check before anything touches the database. */
export const isLinkCode = (code) => typeof code === "string" && CODE_PATTERN.test(code);

export const joinUrl = (code) => `${config.links.joinBaseUrl}/join/${code}`;

/** A group closed, closing or still waiting on its fee takes nobody through a link. */
const takesMembers = (group) => group.status === "active";

/**
 * What a code points at:
 *   { kind: "group", group }            - a live share link
 *   { kind: "expired", group }          - a share link past its expiry
 *   { kind: "invite", group, member }   - a pending invite's personal link
 *   null                                - unknown, reset, answered or withdrawn
 * A group that isn't active (closed, closing, unpaid) counts as null.
 */
export async function findLink(code) {
  if (!isLinkCode(code)) return null;

  const shared = await Group.findOne({ "shareLink.code": code });
  if (shared) {
    if (!takesMembers(shared)) return null;
    if (new Date(shared.shareLink.expiresAt) <= new Date())
      return { kind: "expired", group: shared };
    return { kind: "group", group: shared };
  }

  const invited = await Group.findOne({
    members: { $elemMatch: { inviteCode: code, status: "pending" } },
  });
  if (invited && takesMembers(invited)) {
    const member = invited.members.find(
      (m) => m.inviteCode === code && m.status === "pending"
    );
    if (member) return { kind: "invite", group: invited, member };
  }
  return null;
}

/** What someone opening a link sees of the group - the same as search shows. */
export function groupSummary(group) {
  const members = group.members ?? [];
  return {
    id: String(group._id),
    name: group.name,
    groupType: group.groupType,
    memberCount: members.filter((m) => m.status === "active").length,
    contributionAmount: group.contributionAmount,
    contributionFrequency: group.contributionFrequency,
    chairpersonName:
      members.find((m) => m.status === "active" && m.role === "Chairperson")?.name || null,
  };
}

/**
 * The code for a pending invite's personal link, creating it for invites made
 * before links existed. Conditional on no code being stored yet, so two admins
 * copying the same invite at once both get the code that sticks. Returns null
 * once the invite is no longer pending.
 */
export async function ensureInviteCode(groupId, member) {
  if (member.inviteCode) return member.inviteCode;
  const code = newLinkCode();
  const result = await Group.updateOne(
    {
      _id: groupId,
      members: {
        $elemMatch: { _id: member._id, status: "pending", inviteCode: { $exists: false } },
      },
    },
    { $set: { "members.$.inviteCode": code } }
  );
  if (result.modifiedCount === 1) return code;

  const stored = await Group.findOne(
    { _id: groupId, "members._id": member._id },
    { "members.$": 1 }
  ).lean();
  const row = stored?.members?.[0];
  return row?.status === "pending" ? row.inviteCode ?? null : null;
}

function freshShareLink(userId) {
  const now = new Date();
  return {
    code: newLinkCode(),
    expiresAt: new Date(now.getTime() + config.links.shareLinkDays * 24 * 60 * 60 * 1000),
    createdAt: now,
    createdBy: userId,
  };
}

/**
 * The group's current share link, making a new one when there is none or it
 * has expired. The write is conditional on the link it replaces, so two admins
 * sharing at the same moment end up handing out the same code.
 */
export async function ensureShareLink(group, userId) {
  const current = group.shareLink;
  if (current?.code && new Date(current.expiresAt) > new Date()) return current;

  const link = freshShareLink(userId);
  const result = await Group.updateOne(
    {
      _id: group._id,
      "shareLink.code": current?.code ? current.code : { $exists: false },
    },
    { $set: { shareLink: link } }
  );
  if (result.modifiedCount === 1) return link;

  const stored = await Group.findById(group._id).select("shareLink").lean();
  return stored?.shareLink ?? null;
}

/** Replace the share link outright: the old code stops working immediately. */
export async function resetShareLink(group, userId) {
  const link = freshShareLink(userId);
  await Group.updateOne({ _id: group._id }, { $set: { shareLink: link } });
  return link;
}

/**
 * The invitation SMS. The link page offers the Play Store download, so the
 * message no longer carries the store URL itself (and fits one SMS more often).
 */
export function inviteSmsText({ inviterName, groupName, role, code, reminder = false }) {
  const as = role && role !== "Member" ? ` as ${role}` : "";
  const target = code
    ? `Tap to join: ${joinUrl(code)}`
    : `Download the app and sign up with this number to join: ${config.links.playStoreUrl}`;
  return `${reminder ? "Reminder: " : ""}${inviterName} invited you to join ${groupName} on Chuma${as}. ${target}`;
}

export default {
  newLinkCode,
  isLinkCode,
  joinUrl,
  findLink,
  groupSummary,
  ensureInviteCode,
  ensureShareLink,
  resetShareLink,
  inviteSmsText,
};
