import express from "express";
import mongoose from "mongoose";
import { Group } from "../models/Group.js";
import { User } from "../models/User.js";
import { Notification } from "../models/Notification.js";
import { Transaction } from "../models/Transaction.js";
import { Approval } from "../models/Approval.js";
import { Loan } from "../models/Loan.js";
import { asyncHandler } from "../middleware/error.js";
import { requireAuth, requireKyc, requireRealName } from "../middleware/auth.js";
import {
  requireGroupMember,
  requireGroupAdmin,
  ADMIN_ROLES,
} from "../middleware/groupAuth.js";
import { paymentLimiter, inviteLimiter } from "../middleware/rateLimits.js";
import {
  generateReceiptId,
  normalizePhone,
} from "../utils/helpers.js";
import {
  getGraceInfo,
  getMonthsOwed,
  getAmountOwed,
  isGroupLocked,
  advanceContributionDate,
  getRepaymentRate,
  getDefaults,
  getSavingsGrowth,
  getRequiredApprovals,
} from "../services/logic.service.js";
import {
  initiateDeposit,
  providerFromPhone,
} from "../services/pawapay.service.js";
import { sendSms } from "../services/sms.service.js";
import { notify, notifyAll } from "../services/notify.service.js";
import { settleCompletedTransaction } from "../services/settlement.service.js";
import config from "../config/index.js";

const router = express.Router();

// Roles an admin may hand out through an invite. Chairperson is deliberately
// absent: it is set when the group is created and changing it is a transfer of
// control, not an invite.
const INVITABLE_ROLES = ["Member", "Treasurer", "Secretary"];

/** Attach computed fee/lock status to a group object for responses. */
function withFeeStatus(group) {
  const g = group.toObject ? group.toObject() : group;
  const grace = getGraceInfo(g);
  return {
    ...g,
    feeStatus: {
      ...grace,
      monthsOwed: getMonthsOwed(g),
      amountOwed: getAmountOwed(g),
      locked: isGroupLocked(g),
    },
  };
}

/**
 * GET /api/groups  (auth) — groups the user belongs to
 */
router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const groups = await Group.find({
      members: { $elemMatch: { userId: req.userId, status: "active" } },
      status: { $ne: "closed" },
    }).lean();
    res.json({ groups: groups.map(withFeeStatus) });
  })
);

/**
 * GET /api/groups/invites  (auth) — invitations still waiting on this user.
 *
 * The source of truth for a pending invitation is the group's own member row,
 * NOT the invite notification. Notifications get marked read (by opening the
 * inbox, by "mark all as read", by another device), and an invitation must
 * outlive all of that: it disappears only when it is accepted or declined.
 *
 * Matched on userId OR phone so an invite sent before the invitee signed up
 * still reaches them once they claim the number.
 *
 * Declared before GET /:id so "invites" is never read as a group id.
 */
router.get(
  "/invites",
  requireAuth,
  asyncHandler(async (req, res) => {
    // A missing phone would match every member row that has none, so only add
    // the phone arm when there actually is one.
    const identity = [{ userId: req.userId }];
    if (req.user.phone) identity.push({ phone: req.user.phone });

    const groups = await Group.find({
      status: { $ne: "closed" },
      members: { $elemMatch: { status: "pending", $or: identity } },
    }).lean();

    const invites = [];
    for (const g of groups) {
      const member = g.members.find(
        (m) =>
          m.status === "pending" &&
          ((m.userId && String(m.userId) === String(req.userId)) ||
            (m.phone && m.phone === req.user.phone))
      );
      if (!member) continue;
      invites.push({
        memberId: String(member._id),
        groupId: String(g._id),
        groupName: g.name,
        groupType: g.groupType,
        role: member.role || "Member",
        invitedBy: member.invitedByName || null,
        invitedAt: member.invitedAt || null,
        memberCount: g.members.filter((m) => m.status === "active").length,
        contributionAmount: g.contributionAmount,
        contributionFrequency: g.contributionFrequency,
      });
    }

    res.json({ invites });
  })
);

/**
 * GET /api/groups/:id  (auth, member)
 */
router.get(
  "/:id",
  requireAuth,
  requireGroupMember("id"),
  asyncHandler(async (req, res) => {
    res.json({ group: withFeeStatus(req.group) });
  })
);

/**
 * POST /api/groups  (auth) — create a group.
 * Charges month 1 of the monthly fee (K100) via PawaPay deposit from the
 * creator's wallet. Group goes live once payment is ACCEPTED.
 *
 * Body: { name, description, groupType, contributionAmount,
 *         contributionFrequency, shareOutDate, loanInterestRate,
 *         loanMaxMultiplier, constitution, payerPhone }
 */
router.post(
  "/",
  requireAuth,
  requireKyc,
  paymentLimiter,
  asyncHandler(async (req, res) => {
    const body = req.body;
    const now = new Date();
    const feeDueDay = now.getDate() > 28 ? 28 : now.getDate();

    // Anyone verified may found a group — the creator becomes its Chairperson,
    // so there is no prior role to require. Cap how many they can run at once:
    // the client can be bypassed, the fee only bites after the group exists.
    const founded = await Group.countDocuments({
      "governance.chairpersonUserId": req.userId,
      status: { $ne: "closed" },
    });
    if (founded >= config.rules.maxGroupsFounded)
      return res.status(403).json({
        error: `You already run ${founded} groups. Close one before creating another.`,
      });

    const payerPhone = body.payerPhone || req.user.phone;
    const fee = config.rules.groupMonthlyFee;

    // Optional co-admins named at creation — treasurer & secretary. Each becomes
    // a PENDING member with their role and gets an invite notification + SMS,
    // exactly like the /invite endpoint. Without this the phones were stored in
    // governance and never turned into an actual invite (no member, no SMS).
    const coAdminInvites = [];
    for (const [rawPhone, role] of [
      [body.treasurerPhone, "Treasurer"],
      [body.secretaryPhone, "Secretary"],
    ]) {
      if (!rawPhone || typeof rawPhone !== "string") continue;
      const normalized = normalizePhone(rawPhone);
      // Skip the creator's own number and any duplicate across the two fields.
      if (normalized === req.user.phone) continue;
      if (coAdminInvites.some((c) => c.normalized === normalized)) continue;
      const invited = await User.findOne({ phone: normalized });
      coAdminInvites.push({ normalized, role, invited });
    }

    // Build and validate the group BEFORE charging the creator — PawaPay must
    // never collect the fee for a group our own schema would reject (bad
    // groupType, missing name, …), which would orphan the deposit.
    const group = new Group({
      name: body.name,
      description: body.description,
      groupType: body.groupType || "savings-group",
      avatar: body.avatar,
      contributionAmount: body.contributionAmount || 0,
      contributionFrequency: body.contributionFrequency || "Monthly",
      nextContributionDate: advanceContributionDate(now, body.contributionFrequency || "Monthly"),
      shareOutDate: body.shareOutDate ? new Date(body.shareOutDate) : undefined,
      loanInterestRate: body.loanInterestRate ?? 5,
      loanMaxMultiplier: body.loanMaxMultiplier ?? 3,
      constitution: body.constitution || {},
      governance: {
        chairpersonUserId: req.userId,
        treasurerPhone: body.treasurerPhone,
        secretaryPhone: body.secretaryPhone,
      },
      monthlyFee: fee,
      feeDueDay,
      // Month 1 is only marked paid when the fee payment settles; until then
      // the group sits at the start of its grace window (5 days — far longer
      // than a callback takes).
      feePaidThrough: now,
      members: [
        {
          userId: req.userId,
          name: req.user.name,
          phone: req.user.phone,
          role: "Chairperson",
          status: "active",
        },
        ...coAdminInvites.map((c) => ({
          userId: c.invited?._id,
          name: c.invited?.name || c.normalized,
          phone: c.normalized,
          role: c.role,
          invitedByName: req.user.name,
          invitedAt: now,
          lastInviteSentAt: now,
          status: "pending",
        })),
      ],
      status: "active",
    });
    await group.validate(); // ValidationError → 400 via the error middleware

    const feeTxn = new Transaction({
      groupId: group._id,
      groupName: group.name,
      memberId: req.userId,
      memberName: req.user.name,
      type: "fee",
      amount: -fee,
      status: "pending",
      note: "Group registration fee (month 1)",
      receiptId: generateReceiptId("CHF"),
      meta: { months: 1 },
    });
    await feeTxn.validate();

    // Everything checks out — now charge month 1 fee from the creator.
    const deposit = await initiateDeposit({
      amount: fee,
      phone: payerPhone,
      provider: providerFromPhone(payerPhone),
      statementDescription: "Chuma group fee",
      metadata: [{ fieldName: "purpose", fieldValue: "group-creation" }],
    });

    if (deposit.status === "REJECTED") {
      return res
        .status(402)
        .json({ error: "Group fee payment was rejected", detail: deposit.error });
    }

    await group.save();

    // Notify + SMS the treasurer/secretary now that the group exists. Same
    // pattern as /invite: in-app notification only if they already have an
    // account; SMS always so an unregistered invitee knows to sign up.
    for (const c of coAdminInvites) {
      if (c.invited) {
        await Notification.create({
          userId: c.invited._id,
          type: "invite",
          title: "Group invitation",
          body: `${req.user.name} invited you to join ${group.name} as ${c.role}.`,
          groupId: group._id,
          groupName: group.name,
          invitedBy: req.user.name,
        });
      }
      await sendSms(
        c.normalized,
        `${req.user.name} invited you to join ${group.name} on Chuma as ${c.role}. Download the app and sign up with this number to join.`
      );
    }

    // Record the fee transaction
    feeTxn.pawapay = { depositId: deposit.id, status: deposit.status };
    if (deposit.simulated) feeTxn.status = "completed";
    await feeTxn.save();

    if (feeTxn.status === "completed") {
      await settleCompletedTransaction(feeTxn);
      const settled = await Group.findById(group._id);
      return res.status(201).json({ group: withFeeStatus(settled) });
    }

    res.status(201).json({ group: withFeeStatus(group) });
  })
);

/**
 * POST /api/groups/:id/invite  (auth, admin) — invite by phone number.
 * Creates a pending member + invite notification + SMS.
 * Body: { phone, role? }
 */
router.post(
  "/:id/invite",
  requireAuth,
  inviteLimiter,
  requireGroupAdmin("id"),
  asyncHandler(async (req, res) => {
    const { phone, role = "Member" } = req.body;
    if (!phone || typeof phone !== "string")
      return res.status(400).json({ error: "Phone required" });
    const group = req.group;

    // The member subdoc is added with updateOne + $push, which does NOT run
    // schema validators, so an unchecked role would be written verbatim.
    if (!INVITABLE_ROLES.includes(role))
      return res.status(400).json({ error: "Invalid role" });

    // Treasurer and Secretary are single seats. A group cannot end up with two
    // of either through an invite; the chairperson is set at creation and is
    // not transferable this way.
    if (role !== "Member") {
      const held = group.members.find(
        (m) => m.status !== "removed" && m.role === role
      );
      if (held)
        return res
          .status(400)
          .json({ error: `This group already has a ${role.toLowerCase()}` });
    }

    const normalized = normalizePhone(phone);
    const invited = await User.findOne({ phone: normalized });

    // Match on identity as well as phone: a member row's stored phone can drift
    // from the normalized form (the field is optional on memberSchema), and a
    // phone-only check would then re-invite someone already in the group.
    const alreadyIn = group.members.find(
      (m) =>
        m.status !== "removed" &&
        (m.phone === normalized ||
          (invited && m.userId && String(m.userId) === String(invited._id)))
    );
    if (alreadyIn)
      return res.status(400).json({
        error:
          alreadyIn.status === "pending"
            ? "This number has already been invited"
            : "This number is already a member of this group",
      });

    const filter = {
      _id: group._id,
      members: {
        $not: { $elemMatch: { phone: normalized, status: { $ne: "removed" } } },
      },
    };
    if (invited) {
      filter.$and = [
        {
          members: {
            $not: { $elemMatch: { userId: invited._id, status: { $ne: "removed" } } },
          },
        },
      ];
    }

    const result = await Group.updateOne(
      filter,
      {
        $push: {
          members: {
            userId: invited?._id,
            name: invited?.name || normalized,
            phone: normalized,
            role,
            invitedByName: req.user.name,
            invitedAt: new Date(),
            lastInviteSentAt: new Date(),
            status: "pending",
          },
        },
      }
    );
    if (result.matchedCount === 0)
      return res.status(400).json({ error: "This number is already in the group" });

    // Notification (if the invitee already has an account)
    if (invited) {
      await Notification.create({
        userId: invited._id,
        type: "invite",
        title: "Group invitation",
        body: `${req.user.name} invited you to join ${group.name}.`,
        groupId: group._id,
        groupName: group.name,
        invitedBy: req.user.name,
      });
    }

    // SMS invite
    await sendSms(
      normalized,
      `${req.user.name} invited you to join ${group.name} on Chuma. Download the app and sign up with this number to join.`
    );

    res.json({ message: "Invite sent" });
  })
);

/**
 * POST /api/groups/:id/invite/:memberId/resend  (auth, admin) — resend a
 * pending invite. The first SMS can be missed (phone off, wrong number typed,
 * carrier drop), and until now the only path back was /invite, which refuses a
 * number that is already pending. This re-sends the SMS and, if the invitee has
 * signed up since the original invite, back-fills their userId and drops the
 * in-app notification they never got.
 */
router.post(
  "/:id/invite/:memberId/resend",
  requireAuth,
  inviteLimiter,
  requireGroupAdmin("id"),
  asyncHandler(async (req, res) => {
    const group = req.group;
    if (!mongoose.isValidObjectId(req.params.memberId))
      return res.status(400).json({ error: "Valid memberId required" });
    const member = group.members.id(req.params.memberId);
    if (!member) return res.status(404).json({ error: "Invite not found" });
    if (member.status !== "pending")
      return res.status(400).json({
        error:
          member.status === "active"
            ? "This person has already joined the group"
            : "This person is no longer invited to the group",
      });
    if (!member.phone)
      return res.status(400).json({ error: "This invite has no phone number" });

    // Don't let an admin machine-gun someone's phone. One resend per minute is
    // plenty for "it didn't arrive, try again".
    const RESEND_COOLDOWN_MS = 60 * 1000;
    if (
      member.lastInviteSentAt &&
      Date.now() - new Date(member.lastInviteSentAt).getTime() < RESEND_COOLDOWN_MS
    )
      return res
        .status(429)
        .json({ error: "Invite just sent. Wait a minute before resending." });

    // The invitee may have registered after the original invite; link them now
    // so the invitation shows up in their app, not only over SMS.
    const invited = await User.findOne({ phone: member.phone });
    const now = new Date();
    const set = { "members.$.lastInviteSentAt": now };
    if (invited && !member.userId) {
      set["members.$.userId"] = invited._id;
      if (invited.name) set["members.$.name"] = invited.name;
    }
    await Group.updateOne(
      { _id: group._id, members: { $elemMatch: { _id: member._id, status: "pending" } } },
      { $set: set }
    );

    if (invited) {
      await Notification.create({
        userId: invited._id,
        type: "invite",
        title: "Group invitation",
        body: `${req.user.name} invited you to join ${group.name}${
          member.role && member.role !== "Member" ? ` as ${member.role}` : ""
        }.`,
        groupId: group._id,
        groupName: group.name,
        invitedBy: req.user.name,
      });
    }

    await sendSms(
      member.phone,
      `Reminder: ${req.user.name} invited you to join ${group.name} on Chuma. Download the app and sign up with this number to join.`
    );

    res.json({ message: "Invite resent", lastInviteSentAt: now });
  })
);

/**
 * DELETE /api/groups/:id/invite/:memberId  (auth, admin) — cancel a pending
 * invite. Only pending rows can be cancelled; an active member is removed
 * through the member-removal flow, not here.
 */
router.delete(
  "/:id/invite/:memberId",
  requireAuth,
  requireGroupAdmin("id"),
  asyncHandler(async (req, res) => {
    const group = req.group;
    if (!mongoose.isValidObjectId(req.params.memberId))
      return res.status(400).json({ error: "Valid memberId required" });
    const member = group.members.id(req.params.memberId);
    if (!member) return res.status(404).json({ error: "Invite not found" });
    if (member.status !== "pending")
      return res
        .status(400)
        .json({ error: "Only a pending invite can be cancelled" });

    const result = await Group.updateOne(
      { _id: group._id, members: { $elemMatch: { _id: member._id, status: "pending" } } },
      { $pull: { members: { _id: member._id } } }
    );
    if (result.modifiedCount === 0)
      return res.status(409).json({ error: "Invite already handled" });

    // Clear the invite notification so the invitee isn't left tapping a dead one.
    if (member.userId) {
      await Notification.deleteMany({
        userId: member.userId,
        groupId: group._id,
        type: "invite",
      });
    }

    res.json({ message: "Invite cancelled" });
  })
);

/**
 * POST /api/groups/:id/accept  (auth) — accept a pending invite.
 */
router.post(
  "/:id/accept",
  requireAuth,
  asyncHandler(async (req, res) => {
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: "Group not found" });

    const mine = group.members.filter(
      (m) =>
        (m.userId && String(m.userId) === String(req.userId)) ||
        m.phone === req.user.phone
    );

    // A stale invite notification can outlive the invite itself — the user may
    // have already joined from another device, or been added directly. Accepting
    // again is a no-op success so the notification can be cleared, not an error.
    if (mine.some((m) => m.status === "active"))
      return res.json({
        message: "Already a member",
        alreadyMember: true,
        group: withFeeStatus(group),
      });

    // Only a PENDING invite can be accepted — a member removed by the group's
    // admins must be re-invited, not re-activate themselves.
    const member = mine.find((m) => m.status === "pending");
    if (!member)
      return res.status(404).json({ error: "No invite found for you" });

    await Group.updateOne(
      { _id: group._id, members: { $elemMatch: { _id: member._id, status: "pending" } } },
      {
        $set: {
          "members.$.status": "active",
          "members.$.userId": req.userId,
          "members.$.name": req.user.name,
        },
      }
    );
    // Reflect in the in-memory doc for the response payload only (not persisted).
    member.status = "active";
    member.userId = req.userId;
    member.name = req.user.name;

    // Retire the invite notification here rather than leaving it to the client:
    // the invitation is answered now, and every client reads "answered" from
    // the member row, so a stale actionable invite in the inbox helps no one.
    await Notification.updateMany(
      { userId: req.userId, groupId: group._id, type: "invite", read: false },
      { $set: { read: true } }
    );

    // Let the chairperson know their invitee accepted (and with which role, when
    // it's an admin role like Treasurer/Secretary). Skip if the chairperson is
    // the one accepting (can't happen for a pending invite, but be safe).
    const chairId = group.governance?.chairpersonUserId;
    if (chairId && String(chairId) !== String(req.userId)) {
      const roleSuffix =
        member.role && member.role !== "Member" ? ` as ${member.role}` : "";
      await Notification.create({
        userId: chairId,
        type: "invite_accepted",
        title: "Invitation accepted",
        body: `${req.user.name} accepted your invitation and joined ${group.name}${roleSuffix}.`,
        groupId: group._id,
        groupName: group.name,
      });
    }

    res.json({ message: "Joined group", group: withFeeStatus(group) });
  })
);

/**
 * POST /api/groups/:id/decline  (auth) — decline a pending invite.
 *
 * The counterpart to /accept: these two are the ONLY things that clear an
 * invitation. The pending member row is pulled, so the invitation stops
 * showing up for the invitee and the admins are free to re-invite them later.
 */
router.post(
  "/:id/decline",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id))
      return res.status(400).json({ error: "Valid group id required" });
    const group = await Group.findById(req.params.id);
    if (!group) return res.status(404).json({ error: "Group not found" });

    const mine = group.members.filter(
      (m) =>
        (m.userId && String(m.userId) === String(req.userId)) ||
        (m.phone && m.phone === req.user.phone)
    );

    // Already joined: leaving a group is its own flow, not a declined invite.
    if (mine.some((m) => m.status === "active"))
      return res
        .status(400)
        .json({ error: "You are already a member of this group" });

    const member = mine.find((m) => m.status === "pending");
    // Nothing pending (cancelled by an admin, or declined on another device).
    // Report success so the client can clear it rather than showing an error.
    if (!member)
      return res.json({ message: "No pending invite", alreadyHandled: true });

    await Group.updateOne(
      { _id: group._id, members: { $elemMatch: { _id: member._id, status: "pending" } } },
      { $pull: { members: { _id: member._id } } }
    );

    // Retire the invite notification so it can't be acted on again.
    await Notification.updateMany(
      { userId: req.userId, groupId: group._id, type: "invite", read: false },
      { $set: { read: true } }
    );

    // Tell the chairperson — a declined invite shouldn't be silent, otherwise
    // they sit waiting on someone who has already said no.
    const chairId = group.governance?.chairpersonUserId;
    if (chairId && String(chairId) !== String(req.userId)) {
      await Notification.create({
        userId: chairId,
        type: "governance",
        title: "Invitation declined",
        body: `${req.user.name} declined your invitation to join ${group.name}.`,
        groupId: group._id,
        groupName: group.name,
      });
    }

    res.json({ message: "Invite declined" });
  })
);

/**
 * GET /api/groups/:id/fee  (auth, member) — fee/lock status + amount owed.
 */
router.get(
  "/:id/fee",
  requireAuth,
  requireGroupMember("id"),
  asyncHandler(async (req, res) => {
    const g = req.group.toObject();
    res.json({
      groupId: g._id,
      groupName: g.name,
      monthlyFee: g.monthlyFee,
      monthsOwed: getMonthsOwed(g),
      amountOwed: getAmountOwed(g),
      grace: getGraceInfo(g),
      locked: isGroupLocked(g),
    });
  })
);

/**
 * POST /api/groups/:id/fee/pay  (auth, member) — pay outstanding monthly fee(s).
 * Charges via PawaPay deposit from the payer, advances feePaidThrough.
 * Body: { payerPhone? }
 */
router.post(
  "/:id/fee/pay",
  requireAuth,
  requireRealName,
  paymentLimiter,
  requireGroupMember("id"),
  asyncHandler(async (req, res) => {
    const group = req.group;
    const g = group.toObject();
    const months = getMonthsOwed(g);
    const amount = getAmountOwed(g);
    if (months <= 0)
      return res.json({ message: "Fee already paid", monthsOwed: 0 });

    const payerPhone = req.body.payerPhone || req.user.phone;

    // Validate the full transaction against the model BEFORE initiating the
    // deposit — PawaPay must never move money for a request we would reject.
    const txn = new Transaction({
      groupId: group._id,
      groupName: group.name,
      memberId: req.userId,
      memberName: req.user.name,
      type: "fee",
      amount: -amount,
      status: "pending",
      note: `Group fee — ${months} month(s)`,
      receiptId: generateReceiptId("CHF"),
      meta: { months },
    });
    await txn.validate(); // ValidationError → 400 via the error middleware

    const deposit = await initiateDeposit({
      amount,
      phone: payerPhone,
      provider: providerFromPhone(payerPhone),
      statementDescription: "Chuma group fee",
      metadata: [{ fieldName: "groupId", fieldValue: String(group._id) }],
    });

    if (deposit.status === "REJECTED") {
      return res
        .status(402)
        .json({ error: "Fee payment rejected", detail: deposit.error });
    }

    // feePaidThrough is only advanced by the settlement service once the
    // payment reaches COMPLETED — inline below for simulated payments.
    txn.pawapay = { depositId: deposit.id, status: deposit.status };
    if (deposit.simulated) txn.status = "completed";
    await txn.save();

    if (txn.status === "completed") {
      await settleCompletedTransaction(txn);
      const settled = await Group.findById(group._id);
      return res.json({
        message: "Group reactivated",
        receipt: {
          receiptId: txn.receiptId,
          amount,
          months,
          paidThrough: settled.feePaidThrough,
        },
        group: withFeeStatus(settled),
      });
    }

    res.json({
      message: "Fee payment processing. Confirm on your phone",
      receipt: { receiptId: txn.receiptId, amount, months },
      group: withFeeStatus(group),
    });
  })
);

/**
 * POST /api/groups/:id/members/:memberId/remove  (auth, admin)
 * Body: { reason?: string }
 *
 * Proposes removing a member. Nobody is removed here: this opens a
 * "member-removal" approval that the group's OTHER admins vote on, and the
 * refund + removal run from the approval executor once they carry it.
 *
 * Who votes: active Chairperson / Treasurer / Secretary, MINUS the person being
 * removed — an admin can never sit on the vote that removes them. Ordinary
 * members hold no vote here, the same as every other sensitive action.
 */
router.post(
  "/:id/members/:memberId/remove",
  requireAuth,
  requireGroupAdmin("id"),
  asyncHandler(async (req, res) => {
    const group = req.group;
    if (!mongoose.isValidObjectId(req.params.memberId))
      return res.status(400).json({ error: "Valid memberId required" });

    const member = group.members.id(req.params.memberId);
    if (!member) return res.status(404).json({ error: "Member not found" });
    if (member.status === "pending")
      return res.status(400).json({
        error: "That invite hasn't been accepted. Withdraw the invite instead",
      });
    if (member.status !== "active")
      return res.status(400).json({ error: "Member is not in this group" });
    if (String(member.userId) === String(req.userId))
      return res
        .status(400)
        .json({ error: "You cannot remove yourself from the group" });

    // An office holder is never removed out from under their office: the group
    // changes who holds the role first, and removes an ordinary member second.
    // This also stops removal being used to unseat the people who vote on it.
    if (ADMIN_ROLES.includes(member.role))
      return res.status(400).json({
        error: `${member.name} is the group's ${member.role}. An admin cannot be removed. Hand the role to someone else first.`,
      });

    // Money is leaving the pool, so the same lock that stops contributions and
    // loans stops a removal — the group settles its fee first.
    if (isGroupLocked(group.toObject()))
      return res.status(403).json({
        error: "Group is locked for unpaid fees. Settle the fee first.",
      });

    // Everyone entitled to vote on THIS removal: active admins, minus the
    // member being removed. With nobody left to vote there is no quorum to
    // reach, so the removal cannot be proposed at all.
    const voters = group.members.filter(
      (m) =>
        m.status === "active" &&
        m.userId &&
        ADMIN_ROLES.includes(m.role) &&
        String(m._id) !== String(member._id)
    );
    if (voters.length === 0)
      return res.status(400).json({
        error:
          "No other admin can vote on this removal. Appoint another admin first.",
      });

    const existing = await Approval.findOne({
      groupId: group._id,
      type: "member-removal",
      refId: member._id,
      status: "pending",
    });
    if (existing)
      return res.status(409).json({
        error: "A removal is already awaiting a decision for this member",
        approval: existing,
      });

    // Their savings are refunded on the way out and clear their own debt first.
    // Owing more than they hold would leave the group short, so that has to be
    // settled while they are still a member.
    const debt = await Loan.aggregate([
      {
        $match: {
          groupId: group._id,
          memberId: member.userId,
          status: { $in: ["active", "overdue"] },
        },
      },
      { $group: { _id: null, total: { $sum: "$outstanding" } } },
    ]);
    const outstanding = debt[0]?.total || 0;
    if (outstanding > (member.savings || 0))
      return res.status(400).json({
        error: `${member.name} owes K${outstanding} against K${member.savings || 0} in savings. The loan must be repaid before they can be removed.`,
      });

    const required = getRequiredApprovals(
      group.constitution?.approvalThreshold || "majority",
      voters.length
    );

    const refund = Math.max(0, (member.savings || 0) - outstanding);
    const approval = await Approval.create({
      groupId: group._id,
      groupName: group.name,
      type: "member-removal",
      title: `Remove ${member.name}`,
      description:
        req.body?.reason?.trim() ||
        `Removal of ${member.name} requested by ${req.user.name}`,
      amount: refund, // what goes back to them if this carries
      requestedById: req.userId,
      requestedBy: req.user.name,
      refId: member._id,
      targetUserId: member.userId,
      targetName: member.name,
      requiredApprovals: required,
    });

    await notifyAll(
      voters.map((v) => v.userId),
      {
        type: "governance",
        title: "Member removal proposed",
        body: `${req.user.name} proposed removing ${member.name} from ${group.name}. ${required} approval${required === 1 ? "" : "s"} needed. K${refund} would be refunded to them.`,
        groupId: group._id,
        groupName: group.name,
        // A vote stalls until these people cast it, and the proposal is
        // holding up someone's money in the meantime.
        sms: true,
        smsText: `Chuma: ${req.user.name} proposed removing ${member.name} from ${group.name}. ${required} approval${required === 1 ? "" : "s"} needed. Vote in the app.`,
      }
    );

    // The member hears it from the group, not from the payout landing later.
    if (member.userId) {
      await notify({
        userId: member.userId,
        type: "governance",
        title: "Your removal was proposed",
        body: `${req.user.name} proposed removing you from ${group.name}. The group's other admins decide. If it carries, your K${member.savings || 0} savings are refunded${outstanding > 0 ? " after clearing your loan" : ""}.`,
        groupId: group._id,
        groupName: group.name,
        // They get no vote on this. The least the group owes them is to not
        // let them find out when the refund lands.
        sms: true,
        smsText: `Chuma: ${req.user.name} proposed removing you from ${group.name}. The other admins vote on it. Open the app for details.`,
      });
    }

    res.json({
      message: "Removal proposed, pending admin approval",
      approval,
      requiredApprovals: required,
      eligibleVoters: voters.length,
      refund,
    });
  })
);

/**
 * POST /api/groups/:id/delete-request  (auth, admin) — request group deletion.
 * Blocked if open loans/savings exist. Routes to admin approval.
 */
router.post(
  "/:id/delete-request",
  requireAuth,
  requireGroupAdmin("id"),
  asyncHandler(async (req, res) => {
    const group = req.group;
    const openLoans = await Loan.countDocuments({
      groupId: group._id,
      status: { $in: ["active", "pending", "overdue"] },
    });
    if (openLoans > 0)
      return res.status(400).json({
        error: "Cannot delete: group has open loans. Settle them first.",
      });
    if (group.totalSavings > 0)
      return res.status(400).json({
        error: "Cannot delete: group still holds savings. Share out first.",
      });

    const approval = await Approval.create({
      groupId: group._id,
      groupName: group.name,
      type: "group-deletion",
      title: `Delete ${group.name}`,
      description: req.body.reason || "Group deletion requested",
      requestedById: req.userId,
      requestedBy: req.user.name,
      requiredApprovals: 2,
    });

    await Group.updateOne(
      { _id: group._id },
      { $set: { status: "deletion-pending" } }
    );
    res.json({ message: "Deletion requested, pending admin approval", approval });
  })
);

export default router;
