import * as hs from './hyperswitch.js';
import { needsExtension } from './intelligence/strategy.js';
import { now } from './db.js';

/**
 * EXTENDED AUTHORIZATION WATCHDOG
 *
 *   requires_capture ──▶ job completes ──▶ capture
 *          │
 *          └──▶ hold nearing capture_by ──▶ extend_authorization ──▶ capture
 *
 * Without this, a job scheduled beyond the standard hold window cannot be
 * captured at completion and the service is performed unpaid. This is what
 * replaces capping how far ahead a customer may book.
 */
export class AuthWatchdog {
  constructor(db, { intervalMs = 5 * 60 * 1000, log = console } = {}) {
    this.db = db; this.intervalMs = intervalMs; this.log = log; this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep().catch(e => this.log.error('watchdog', e)), this.intervalMs);
    this.timer.unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  /** Holds still open, for jobs that have not reached a terminal state. */
  openHolds() {
    return this.db.prepare(`
      SELECT p.* FROM payments p
      LEFT JOIN jobs j ON j.id = p.job_id
      WHERE p.purpose = 'job_authorization'
        AND p.status = 'requires_capture'
        AND (j.state IS NULL OR j.state NOT IN ('COMPLETED','CANCELLED_BY_CUSTOMER','CANCELLED_BY_PROVIDER'))
    `).all();
  }

  async sweep(at = Date.now()) {
    const results = { checked: 0, extended: 0, failed: 0, expired: 0 };
    for (const row of this.openHolds()) {
      results.checked++;

      // Re-fetch rather than trusting our copy: capture_by moves when the
      // connector applies an extension of its own.
      let payment;
      try { payment = await hs.retrievePayment(row.payment_id); }
      catch (err) { results.failed++; this.log.error(`sync ${row.payment_id}`, err.message); continue; }

      const deadline = hs.captureDeadline(payment);
      this.db.prepare('UPDATE payments SET status=?, capture_by=?, updated_at=? WHERE payment_id=?')
        .run(payment.status, deadline, now(), row.payment_id);

      if (deadline && new Date(deadline).getTime() <= at) {
        // Already gone. Surface it loudly — this costs real revenue and the
        // customer may already have had the service.
        results.expired++;
        this.log.error(`AUTH EXPIRED ${row.payment_id} job=${row.job_id} — cannot capture`);
        continue;
      }

      if (!needsExtension({ ...payment, capture_by: deadline }, at)) continue;

      try {
        const ext = await hs.extendAuthorization(row.payment_id, `${row.job_id}:extend:${Date.now()}`);
        const newDeadline = hs.captureDeadline(ext) ?? deadline;
        this.db.prepare('UPDATE payments SET capture_by=?, extended_at=?, updated_at=? WHERE payment_id=?')
          .run(newDeadline, now(), now(), row.payment_id);
        results.extended++;
        this.log.info?.(`extended ${row.payment_id} → ${newDeadline}`);
      } catch (err) {
        // Not every connector supports it. Falling back to alerting is correct:
        // a human can capture early or contact the customer.
        results.failed++;
        this.log.error(`extend failed ${row.payment_id}: ${err.message}`);
      }
    }
    return results;
  }
}
