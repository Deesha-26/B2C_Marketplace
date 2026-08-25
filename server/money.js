/** All money is integer cents — the same minor units Hyperswitch uses on the wire. */
export const CUSTOMER_FEE = 0.075;   // added on top of the bid
export const LEAD_FEE     = 0.15;    // deducted from the bid
export const PENALTY      = 3000;    // $30 cancellation fee, either direction
export const WALLET_FLOOR = 2500;    // $25 minimum kept for tips
export const MIN_TOPUP    = 2500;

export const fmt = c => (c < 0 ? '-' : '') + '$' + (Math.abs(c) / 100).toFixed(2);

/**
 * Fees are charged ON TOP of the bid.
 *
 * platformTake is the residual, not an independent rounding of 22.5%. If both
 * sides were rounded separately a half-cent could appear or vanish and the
 * ledger's zero-sum check would fail on certain bid amounts.
 */
export function economics(bid) {
  if (!Number.isInteger(bid) || bid <= 0) throw new Error(`bad bid: ${bid}`);
  const charge = Math.round(bid * (1 + CUSTOMER_FEE));
  const payout = Math.round(bid * (1 - LEAD_FEE));
  return { bid, fee: charge - bid, charge, payout, take: charge - payout };
}
