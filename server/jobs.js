import { economics, PENALTY } from './money.js';

/**
 * Job lifecycle. Simulated provider progress — there is no provider app.
 *
 *   OPEN_FOR_BIDS → APPROVED → RESERVED → EN_ROUTE → ARRIVED → IN_PROGRESS → COMPLETED
 *
 * APPROVED means the customer consented to a total. RESERVED means Hyperswitch
 * captured it and the ledger earmarked it. They are deliberately separate: one
 * is a Swoop record, the other is verified external execution.
 */
export const STATES = {
  OPEN_FOR_BIDS: 'OPEN_FOR_BIDS',
  APPROVED: 'APPROVED',
  RESERVED: 'RESERVED',
  EN_ROUTE: 'EN_ROUTE',
  ARRIVED: 'ARRIVED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED_PRE_TRAVEL: 'CANCELLED_PRE_TRAVEL',
  CANCELLED_EN_ROUTE: 'CANCELLED_EN_ROUTE',
};

const NEXT = {
  [STATES.RESERVED]: STATES.EN_ROUTE,
  [STATES.EN_ROUTE]: STATES.ARRIVED,
  [STATES.ARRIVED]: STATES.IN_PROGRESS,
};
export const nextState = state => NEXT[state] ?? null;

export const isTerminal = s =>
  [STATES.COMPLETED, STATES.CANCELLED_PRE_TRAVEL, STATES.CANCELLED_EN_ROUTE].includes(s);

/**
 * Which cancellation applies.
 *
 * Before the provider sets off the customer pays nothing. Once travel has begun
 * — en route, arrived or working — the provider keeps $30 travel compensation
 * and the rest returns to the wallet. Swoop takes no fee from that $30.
 */
export function cancellationTier(state) {
  if (state === STATES.RESERVED) return 'PRE_TRAVEL';
  if ([STATES.EN_ROUTE, STATES.ARRIVED, STATES.IN_PROGRESS].includes(state)) return 'EN_ROUTE';
  return null;
}

/** What the customer is told before confirming a cancellation. */
export function cancellationPreview(state, bidAmount) {
  const tier = cancellationTier(state);
  if (!tier) return null;
  const e = economics(bidAmount);
  return tier === 'PRE_TRAVEL'
    ? { tier, retainedByProvider: 0, returnedToWallet: e.charge,
        summary: 'The provider has not set off. The full amount returns to your Swoop wallet.' }
    : { tier, retainedByProvider: PENALTY, returnedToWallet: e.charge - PENALTY,
        summary: `The provider is already travelling and keeps ${PENALTY / 100} as travel compensation. The rest returns to your Swoop wallet.` };
}

/** Seeded providers. Round 1 has no provider onboarding or real bidding. */
export const SEED_PROVIDERS = [
  { providerId: 'prov_ganesan', name: 'Ravi Ganesan', trade: 'Ganesan Plumbing',
    rating: 4.9, etaMinutes: 22, base: 9000,
    note: 'Includes replacing the cartridge and testing for further leaks.' },
  { providerId: 'prov_whitlock', name: 'Dana Whitlock', trade: 'Whitlock & Sons',
    rating: 4.7, etaMinutes: 35, base: 7500,
    note: 'Callout plus one hour of labour. Parts billed separately if needed.' },
  { providerId: 'prov_bayline', name: 'Marcus Oyelaran', trade: 'Bayline Mechanical',
    rating: 5.0, etaMinutes: 14, base: 12500,
    note: 'Same-day, fully insured, 12-month workmanship guarantee.' },
];

/** Emergencies are priced higher; the flag is not merely cosmetic. */
export const bidAmountFor = (base, isEmergency) =>
  isEmergency ? Math.round(base * 1.2) : base;
