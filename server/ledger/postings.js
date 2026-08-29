import { economics, PENALTY } from '../money.js';

/**
 * Every money movement in Round 1, as pure functions.
 *
 * These build balanced entry sets and do no I/O, so the marketplace economics
 * can be tested exhaustively without a database. `ledger/index.js` persists what
 * these return.
 *
 * ACCOUNT NAMING: no simulation suffix. An account is the economic obligation;
 * simulation describes whether the external movement was executed. After a
 * completed job Swoop genuinely owes the provider their earnings within its
 * marketplace accounting model, even though Round 1 executes no payout. That
 * fact is recorded on the transaction, not in the account name.
 */

export const PSP_CLEARING    = 'PSP_CLEARING';
export const PLATFORM_REVENUE = 'PLATFORM_REVENUE';
export const customerWallet   = u => `CUSTOMER_WALLET:${u}`;
export const jobReserved      = j => `JOB_RESERVED:${j}`;
export const providerPayable  = p => `PROVIDER_PAYABLE:${p}`;
export const providerTipPayable = p => `PROVIDER_TIP_PAYABLE:${p}`;
export const withdrawalPayable  = u => `WITHDRAWAL_PAYABLE:${u}`;
export const providerSettlementPayable = p => `PROVIDER_SETTLEMENT_PAYABLE:${p}`;

export const debit  = (account, amount) => ({ account, direction: 'debit',  amount });
export const credit = (account, amount) => ({ account, direction: 'credit', amount });

/** Marks a transaction whose external movement was not executed. */
export const SIMULATED_EXECUTION = {
  execution_mode: 'simulated',
  external_transfer_id: null,
  external_status: 'not_executed',
};

/** Signed value of an entry, used only for the balance check. */
export const signed = e => (e.direction === 'debit' ? e.amount : -e.amount);

export function assertBalanced(reason, entries) {
  if (!entries?.length) throw new Error(`'${reason}' has no entries`);
  if (entries.length < 2) {
    throw new Error(`'${reason}' has ${entries.length} entry — a posting needs at least two sides`);
  }
  if (entries.length < 2) {
    throw new Error(
      `'${reason}' has only ${entries.length} entry after removing zero lines — ` +
      'a double-entry posting needs at least two');
  }
  for (const e of entries) {
    if (!Number.isInteger(e.amount) || e.amount <= 0) {
      throw new Error(
        `'${reason}' entry for ${e.account} has amount ${e.amount} — ` +
        'entries must be positive integer cents; direction carries the sign');
    }
  }
  const delta = entries.reduce((s, e) => s + signed(e), 0);
  if (delta !== 0) throw new Error(`'${reason}' does not balance: off by ${delta} cents`);
  return entries;
}

/**
 * Drops zero-amount entries before validating.
 *
 * A residual can legitimately round to zero — a one-cent bid leaves the platform
 * nothing — and a zero line carries no information. Writing one would also trip
 * the positive-amount guard, which exists to catch genuine mistakes.
 */
const tx = (reason, entries, extra = {}) => ({
  reason,
  // ONLY exact zeroes are dropped. Negative, fractional, NaN and non-numeric
  // amounts fall through to assertBalanced and fail loudly — the filter must
  // never become a way for an invalid amount to disappear quietly.
  entries: assertBalanced(reason, entries.filter(e => e.amount !== 0)),
  metadata: {},
  ...extra,
});

/* ------------------------------------------------------------- wallet ----- */

/** Captured wallet top-up. Real external funds arrived. */
export function walletTopUp({ userId, amount, paymentId }) {
  return tx('WALLET_TOPUP', [
    debit(PSP_CLEARING, amount),
    credit(customerWallet(userId), amount),
  ], { idempotencyKey: `${paymentId}:credit`, paymentId, userId });
}

/* ---------------------------------------------------------------- job ----- */

/**
 * Job payment captured and reserved.
 *
 * Round 1 requests automatic capture, so the money genuinely arrived before this
 * posting. The reservation is internal: it records that captured funds are
 * earmarked for one job and not yet allocated.
 */
export function jobReservation({ userId, jobId, paymentId, total }) {
  return tx('JOB_CAPTURED_AND_RESERVED', [
    debit(PSP_CLEARING, total),
    credit(jobReserved(jobId), total),
  ], { idempotencyKey: `${jobId}:reserve`, paymentId, userId, jobId });
}

/** Job completed — allocate the reservation. Platform take is the residual. */
export function jobCompleted({ userId, jobId, providerId, paymentId, bidAmount }) {
  const e = economics(bidAmount);
  return tx('JOB_COMPLETED', [
    debit(jobReserved(jobId), e.charge),
    credit(providerPayable(providerId), e.payout),
    credit(PLATFORM_REVENUE, e.take),
  ], { idempotencyKey: `${jobId}:settle`, paymentId, userId, jobId });
}

/** Cancelled before the provider set off — the whole reservation returns. */
export function cancelledPreTravel({ userId, jobId, paymentId, bidAmount }) {
  const e = economics(bidAmount);
  return tx('CANCELLED_PRE_TRAVEL', [
    debit(jobReserved(jobId), e.charge),
    credit(customerWallet(userId), e.charge),
  ], { idempotencyKey: `${jobId}:settle`, paymentId, userId, jobId });
}

/**
 * Cancelled after the provider set off.
 *
 * The entire $30 goes to the provider as travel compensation. No lead fee is
 * taken and PLATFORM_REVENUE receives nothing — they travelled, they are paid
 * for travelling.
 */
export function cancelledEnRoute({ userId, jobId, providerId, paymentId, bidAmount }) {
  const e = economics(bidAmount);
  const toCustomer = e.charge - PENALTY;
  if (toCustomer < 0) {
    throw new Error(`job total ${e.charge} is below the ${PENALTY} travel compensation`);
  }
  return tx('CANCELLED_EN_ROUTE', [
    debit(jobReserved(jobId), e.charge),
    credit(providerPayable(providerId), PENALTY),
    credit(customerWallet(userId), toCustomer),
  ], { idempotencyKey: `${jobId}:settle`, paymentId, userId, jobId });
}

/* --------------------------------------------------------------- tips ----- */

/** Tip from the separately funded wallet. The provider keeps all of it. */
export function tip({ userId, jobId, providerId, tipId, amount }) {
  return tx('TIP', [
    debit(customerWallet(userId), amount),
    credit(providerTipPayable(providerId), amount),
  ], { idempotencyKey: `${jobId}:tip:${tipId}`, userId, jobId });
}

/* --------------------------------------------------- simulated movements -- */

/**
 * Simulated withdrawal.
 *
 * Reclassifies one liability into another: Swoop still owes the money, it has
 * simply moved from wallet to withdrawal payable. PSP_CLEARING is untouched
 * because nothing left Swoop — no refund, payout or transfer was executed.
 */
export function simulatedWithdrawal({ userId, withdrawalId, amount }) {
  return tx('WITHDRAWAL_SIMULATED', [
    debit(customerWallet(userId), amount),
    credit(withdrawalPayable(userId), amount),
  ], {
    idempotencyKey: `${userId}:withdraw:${withdrawalId}`,
    userId,
    metadata: SIMULATED_EXECUTION,
  });
}

/** Simulated provider settlement. Again a liability reclassification only. */
export function simulatedProviderSettlement({ providerId, settlementId, amount }) {
  return tx('PROVIDER_SETTLEMENT_SIMULATED', [
    debit(providerPayable(providerId), amount),
    credit(providerSettlementPayable(providerId), amount),
  ], {
    idempotencyKey: `${providerId}:settle:${settlementId}`,
    metadata: SIMULATED_EXECUTION,
  });
}

/** True when a transaction records an obligation whose transfer was not run. */
export const isSimulated = t => t?.metadata?.execution_mode === 'simulated';
