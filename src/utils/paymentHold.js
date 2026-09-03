/**
 * The mobile money hold.
 *
 * Loan disbursement over pawaPay is not live yet, and a group where money can
 * come in electronically but cannot go out the same way is worse than one that
 * runs on cash end to end: members' savings would be locked behind a payout
 * that never happens. So while the hold is on, every flow that moves MEMBER
 * money is cash — paid to, or handed out by, an admin who confirms it.
 *
 * Platform fees are the exception (group creation, the monthly group fee):
 * that money goes to the app, not between members, and it never needed a
 * payout. Those routes simply never call in here.
 *
 * One switch: config.payments.mobileMoneyHold (env MOBILE_MONEY_HOLD).
 */
import { config } from "../config/index.js";

/** True while member money must move as cash. */
export const isMobileMoneyOnHold = () => config.payments.mobileMoneyHold;

export const MOBILE_MONEY_HOLD_MESSAGE =
  "Mobile money is paused for now. This payment has to be cash, confirmed by an admin.";

/**
 * Guard for a member-money route: returns a 503 body when the caller asked to
 * pay by anything other than cash while the hold is on, otherwise null.
 */
export function rejectIfMobileMoneyHeld(paymentMethod) {
  if (!isMobileMoneyOnHold()) return null;
  if (paymentMethod === "Cash") return null;
  return {
    status: 503,
    body: { error: MOBILE_MONEY_HOLD_MESSAGE, mobileMoneyHold: true },
  };
}

export default {
  isMobileMoneyOnHold,
  rejectIfMobileMoneyHeld,
  MOBILE_MONEY_HOLD_MESSAGE,
};
