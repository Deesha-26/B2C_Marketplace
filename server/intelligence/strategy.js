import { economics } from '../money.js';

/**
 * PAYMENT STRATEGY — turns a domain intent plus a risk assessment into the exact
 * Hyperswitch request body.
 *
 * Nothing above this layer knows about capture_method or setup_future_usage,
 * and nothing below it knows what a job is.
 */

/** Wallet top-up: the customer is buying balance, so take the money now. */
export function topupRequest({ user, amount, saveCard, savedPaymentMethodId }) {
  const body = {
    amount, currency: 'USD', confirm: false,
    capture_method: 'automatic',
    customer_id: user.id,                 // no separate Customers call needed
    description: 'Swoop wallet top-up',
    metadata: { swoop_user_id: user.id, purpose: 'wallet_topup' },
  };
  if (saveCard) {
    body.setup_future_usage = 'off_session';   // vault the card for next time
  }
  if (savedPaymentMethodId) {
    body.payment_method_id = savedPaymentMethodId;
  }
  return body;
}

/**
 * Job authorization: hold the exact bid plus the customer fee, and capture only
 * when the work is done. Extended authorization is requested when risk says the
 * hold has to outlive a standard window — it is valid only for manual capture.
 */
export function authorizeRequest({ user, job, bid, risk }) {
  const e = economics(bid.amount);
  return {
    request: {
      amount: e.charge, currency: 'USD', confirm: false,
      capture_method: 'manual',
      request_extended_authorization: risk.needsExtendedAuth,
      authentication_type: risk.require3ds ? 'three_ds' : 'no_three_ds',
      customer_id: user.id,
      description: `${job.service} — ${bid.trade}`,
      metadata: {
        swoop_user_id: user.id, swoop_job_id: job.id,
        purpose: 'job_authorization', bid_amount: String(e.bid),
      },
    },
    economics: e,
  };
}

/** How close to the capture deadline we act. Leaves room for a failed attempt. */
export const EXTEND_THRESHOLD_MS = 6 * 60 * 60 * 1000;

export function needsExtension(payment, at = Date.now()) {
  if (payment.status !== 'requires_capture') return false;
  if (!payment.capture_by) return false;
  return new Date(payment.capture_by).getTime() - at < EXTEND_THRESHOLD_MS;
}
