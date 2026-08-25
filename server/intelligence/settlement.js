import { economics, PENALTY } from '../money.js';

/**
 * SETTLEMENT — decides how a job's authorization resolves, and what the ledger
 * postings are. Pure: no I/O, fully testable.
 *
 * The three cancellation tiers come straight from the customer flow diagram.
 * ARRIVED sits with IN_PROGRESS deliberately: arriving on site is the point of
 * no return, and the provider is made whole from there on.
 */
const TIERS = {
  SCHEDULED:   'VOID',
  EN_ROUTE:    'PARTIAL_CAPTURE',
  ARRIVED:     'FULL_CAPTURE',
  IN_PROGRESS: 'FULL_CAPTURE',
};

export const cancelTier = state => TIERS[state] ?? null;

/**
 * Returns the gateway operation and the amounts. The caller performs the call
 * and posts the ledger entries; this only decides.
 */
export function planCancellation(state, bidAmount) {
  const e = economics(bidAmount);
  const tier = cancelTier(state);
  if (!tier) return null;

  if (tier === 'VOID') return {
    tier, operation: 'void', charged: 0, released: e.charge,
    toProvider: 0, toPlatform: 0, economics: e,
    summary: 'Nothing charged — the hold is released in full.',
  };

  if (tier === 'PARTIAL_CAPTURE') return {
    // Capturing less than the authorized amount voids the remainder at the
    // processor, so this is a partial settlement, not a partial refund.
    tier, operation: 'capture', captureAmount: PENALTY,
    charged: PENALTY, released: e.charge - PENALTY,
    // Travel compensation is not subject to the 15% lead fee.
    toProvider: PENALTY, toPlatform: 0, economics: e,
    summary: `${PENALTY / 100} charged for the trip; the rest of the hold is released.`,
  };

  return {
    tier, operation: 'capture', captureAmount: e.charge,
    charged: e.charge, released: 0,
    toProvider: e.payout, toPlatform: e.take, economics: e,
    summary: 'Charged in full — work had already started.',
  };
}

export function planCompletion(bidAmount) {
  const e = economics(bidAmount);
  return {
    operation: 'capture', captureAmount: e.charge,
    charged: e.charge, toProvider: e.payout, toPlatform: e.take, economics: e,
  };
}

/** Provider pulls out: the hold is voided and they pay the customer $30. */
export function planProviderCancellation(bidAmount) {
  const e = economics(bidAmount);
  return { operation: 'void', charged: 0, released: e.charge,
           compensation: PENALTY, economics: e };
}
