/**
 * Ledger posting tests — pure, no database.
 *
 * These prove the marketplace economics: every transaction balances, the fee
 * residual never loses a cent, and each cancellation tier allocates exactly what
 * the approved plan says.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { economics, PENALTY } from '../server/money.js';
import {
  walletTopUp, jobReservation, jobCompleted, cancelledPreTravel, cancelledEnRoute, cancelledInProgress,
  tip, simulatedWithdrawal, simulatedProviderSettlement,
  assertBalanced, signed, isSimulated, debit, credit,
  PSP_CLEARING, PLATFORM_REVENUE, customerWallet, jobReserved,
  providerPayable, providerTipPayable, withdrawalPayable, providerSettlementPayable,
} from '../server/ledger/postings.js';

const U = '11111111-1111-1111-1111-111111111111';
const J = 'job_1', P = 'prov_1', PAY = 'pay_1';
const BID = 9000;                      // $90.00
const E = economics(BID);              // charge 9675, payout 7650, take 2025

/** Net movement on one account across a transaction. */
const on = (t, account) => 0 -
  t.entries.filter(e => e.account === account).reduce((s, e) => s - signed(e), 0);

const ALL = [
  ['walletTopUp',        walletTopUp({ userId: U, amount: 2500, paymentId: PAY })],
  ['jobReservation',     jobReservation({ userId: U, jobId: J, paymentId: PAY, total: E.charge })],
  ['jobCompleted',       jobCompleted({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: BID })],
  ['cancelledPreTravel', cancelledPreTravel({ userId: U, jobId: J, paymentId: PAY, bidAmount: BID })],
  ['cancelledEnRoute',   cancelledEnRoute({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: BID })],
  ['cancelledInProgress',
  cancelledInProgress({
    userId: U,
    jobId: J,
    providerId: P,
    paymentId: PAY,
    bidAmount: BID,
  }),
],
  ['tip',                tip({ userId: U, jobId: J, providerId: P, tipId: 't1', amount: 1000 })],
  ['simulatedWithdrawal', simulatedWithdrawal({ userId: U, withdrawalId: 'w1', amount: 1500 })],
  ['simulatedSettlement', simulatedProviderSettlement({ providerId: P, settlementId: 's1', amount: E.payout })],
];

describe('every posting balances', () => {
  for (const [name, t] of ALL) {
    test(`${name} sums to zero`, () => {
      assert.equal(t.entries.reduce((s, e) => s + signed(e), 0), 0);
    });
    test(`${name} has an idempotency key`, () => {
      assert.ok(t.idempotencyKey, 'retrying an operation must not create a second transaction');
    });
    test(`${name} uses positive amounts with an explicit direction`, () => {
      for (const e of t.entries) {
        assert.ok(Number.isInteger(e.amount) && e.amount > 0, `${e.account} amount ${e.amount}`);
        assert.ok(['debit', 'credit'].includes(e.direction));
      }
    });
  }
});

describe('balance guard', () => {
  test('a one-sided posting is refused', () => {
    assert.throws(() => assertBalanced('BAD', [debit('A', 100)]), /at least two sides/);
  });
  test('a two-sided posting that does not balance is refused', () => {
    assert.throws(() => assertBalanced('BAD', [debit('A', 100), credit('B', 90)]),
      /does not balance: off by 10 cents/);
  });
  test('zero entries are dropped, but a posting must keep two real sides', () => {
    // A residual rounding to zero is fine; a posting reduced to one side is not.
    assert.throws(() => assertBalanced('BAD', [debit('A', 0), credit('B', 0)].filter(e => e.amount !== 0)),
      /has no entries/);
  });
  test('a negative amount is refused', () => {
    assert.throws(() => assertBalanced('BAD', [debit('A', -100), credit('B', -100)]),
      /positive integer cents/);
  });
  test('a non-integer amount is refused', () => {
    assert.throws(() => assertBalanced('BAD', [debit('A', 10.5), credit('B', 10.5)]),
      /positive integer cents/);
  });
  test('a promise sneaking in as an amount is refused', () => {
    assert.throws(() => assertBalanced('BAD', [debit('A', Promise.resolve(5)), credit('B', 5)]),
      /positive integer cents/);
  });
});

describe('wallet top-up', () => {
  const t = walletTopUp({ userId: U, amount: 2500, paymentId: PAY });
  test('external funds arrive and the wallet is credited', () => {
    assert.equal(on(t, PSP_CLEARING), 2500);
    assert.equal(on(t, customerWallet(U)), -2500);   // liability increases
  });
  test('it is keyed to the funding payment', () => {
    assert.equal(t.idempotencyKey, `${PAY}:credit`);
    assert.equal(t.paymentId, PAY);
  });
  test('it is not marked simulated — the money really moved', () => {
    assert.equal(isSimulated(t), false);
  });
});

describe('job capture and reservation', () => {
  const t = jobReservation({ userId: U, jobId: J, paymentId: PAY, total: E.charge });
  test('captured funds are earmarked for the job', () => {
    assert.equal(on(t, PSP_CLEARING), E.charge);
    assert.equal(on(t, jobReserved(J)), -E.charge);
  });
  test('the customer wallet is untouched', () => {
    assert.equal(on(t, customerWallet(U)), 0, 'job payments charge the card, not the wallet');
  });
});

describe('job completed', () => {
  const t = jobCompleted({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: BID });
  test('the reservation is fully drained', () => {
    assert.equal(on(t, jobReserved(J)), E.charge);
  });
  test('provider and platform split the total exactly', () => {
    assert.equal(on(t, providerPayable(P)), -E.payout);
    assert.equal(on(t, PLATFORM_REVENUE), -E.take);
    assert.equal(E.payout + E.take, E.charge);
  });
  test('the provider payable is a real obligation, not marked simulated', () => {
    assert.equal(isSimulated(t), false,
      'Swoop owes this money; only the external payout is deferred');
  });
});

describe('cancelled before travel', () => {
  const t = cancelledPreTravel({ userId: U, jobId: J, paymentId: PAY, bidAmount: BID });
  test('the whole reservation returns to the wallet', () => {
    assert.equal(on(t, jobReserved(J)), E.charge);
    assert.equal(on(t, customerWallet(U)), -E.charge);
  });
  test('neither provider nor platform receives anything', () => {
    assert.equal(on(t, providerPayable(P)), 0);
    assert.equal(on(t, PLATFORM_REVENUE), 0);
  });
});

describe('cancelled en route', () => {
  const t = cancelledEnRoute({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: BID });

  test('the provider receives exactly $30', () => {
    assert.equal(on(t, providerPayable(P)), -PENALTY);
    assert.equal(PENALTY, 3000);
  });

  test('platform revenue receives exactly $0', () => {
    assert.equal(on(t, PLATFORM_REVENUE), 0,
      'Swoop takes no fee from travel compensation');
  });

  test('the customer receives the remainder', () => {
    assert.equal(on(t, customerWallet(U)), -(E.charge - PENALTY));
  });

  test('the reservation is fully drained', () => {
    assert.equal(on(t, jobReserved(J)), E.charge);
  });

  test('a job smaller than the travel compensation is refused rather than mis-split', () => {
    assert.throws(
      () => cancelledEnRoute({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: 500 }),
      /below the .* travel compensation/);
  });
});

describe('cancelled after work started', () => {
  const t = cancelledInProgress({
    userId: U,
    jobId: J,
    providerId: P,
    paymentId: PAY,
    bidAmount: BID,
  });

  test('the customer receives no wallet credit', () => {
    assert.equal(on(t, customerWallet(U)), 0);
  });

  test('the provider receives the normal net payout', () => {
    assert.equal(on(t, providerPayable(P)), -E.payout);
  });

  test('the platform receives its normal marketplace revenue', () => {
    assert.equal(on(t, PLATFORM_REVENUE), -E.take);
  });

  test('the complete reservation is drained', () => {
    assert.equal(on(t, jobReserved(J)), E.charge);
  });
});

describe('tips', () => {
  const t = tip({ userId: U, jobId: J, providerId: P, tipId: 't1', amount: 1000 });
  test('the wallet funds it and the provider keeps all of it', () => {
    assert.equal(on(t, customerWallet(U)), 1000);
    assert.equal(on(t, providerTipPayable(P)), -1000);
  });
  test('no fee is taken', () => {
    assert.equal(on(t, PLATFORM_REVENUE), 0);
  });
  test('captured funds are not involved', () => {
    assert.equal(on(t, PSP_CLEARING), 0, 'tips move existing wallet balance');
  });
});

describe('simulated movements', () => {
  const w = simulatedWithdrawal({ userId: U, withdrawalId: 'w1', amount: 1500 });
  const s = simulatedProviderSettlement({ providerId: P, settlementId: 's1', amount: E.payout });

  test('withdrawal reclassifies one liability into another', () => {
    assert.equal(on(w, customerWallet(U)), 1500);
    assert.equal(on(w, withdrawalPayable(U)), -1500);
  });

  test('withdrawal does not touch captured funds', () => {
    assert.equal(on(w, PSP_CLEARING), 0,
      'no refund, payout or transfer was executed, so nothing left Swoop');
  });

  test('provider settlement reclassifies payable into settlement payable', () => {
    assert.equal(on(s, providerPayable(P)), E.payout);
    assert.equal(on(s, providerSettlementPayable(P)), -E.payout);
  });

  test('both carry the simulated execution marker, not a suffixed account', () => {
    for (const t of [w, s]) {
      assert.equal(isSimulated(t), true);
      assert.equal(t.metadata.external_transfer_id, null);
      assert.equal(t.metadata.external_status, 'not_executed');
      for (const e of t.entries) {
        assert.ok(!/_SIMULATED/.test(e.account),
          `${e.account} must name the obligation, not the execution mode`);
      }
    }
  });
});

describe('fee model', () => {
  test('the residual absorbs rounding for every bid up to $500', () => {
    for (let bid = 1; bid <= 50000; bid++) {
      const e = economics(bid);
      assert.equal(e.payout + e.take, e.charge, `imbalance at bid=${bid}`);
    }
  });

  test('completion balances at awkward amounts where rounding bites', () => {
    for (const bid of [1, 7, 99, 733, 9733, 12345, 49999]) {
      const t = jobCompleted({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: bid });
      assert.equal(t.entries.reduce((s, e) => s + signed(e), 0), 0, `bid=${bid}`);
    }
  });

  test('en-route cancellation balances at awkward amounts', () => {
    for (const bid of [3000, 3001, 9733, 12345, 49999]) {
      const t = cancelledEnRoute({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: bid });
      assert.equal(t.entries.reduce((s, e) => s + signed(e), 0), 0, `bid=${bid}`);
      assert.equal(on(t, providerPayable(P)), -PENALTY, `bid=${bid}: provider must get exactly $30`);
    }
  });
});

test('in-progress cancellation balances at awkward amounts', () => {
  for (const bid of [1, 7, 99, 733, 9733, 12345, 49999]) {
    const e = economics(bid);

    const t = cancelledInProgress({
      userId: U,
      jobId: J,
      providerId: P,
      paymentId: PAY,
      bidAmount: bid,
    });

    assert.equal(
      t.entries.reduce((sum, entry) => sum + signed(entry), 0),
      0,
      `bid=${bid}`
    );

    assert.equal(
      on(t, providerPayable(P)),
      -e.payout,
      `bid=${bid}: provider payout`
    );

    assert.equal(
      on(t, PLATFORM_REVENUE),
      0 - e.take,
      `bid=${bid}: platform revenue`
    );
  }
});

describe('idempotency keys are deterministic', () => {
  test('the same operation produces the same key twice', () => {
    const a = jobCompleted({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: BID });
    const b = jobCompleted({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: BID });
    assert.equal(a.idempotencyKey, b.idempotencyKey);
  });

  test('all four job outcomes share one settlement key', () => {
    const keys = [
      jobCompleted({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: BID }),
      cancelledPreTravel({ userId: U, jobId: J, paymentId: PAY, bidAmount: BID }),
      cancelledEnRoute({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: BID }),
      cancelledInProgress({
        userId: U,
        jobId: J,
        providerId: P,
        paymentId: PAY,
        bidAmount: BID,
      }),
    ].map(t => t.idempotencyKey);
    assert.deepEqual(new Set(keys), new Set([`${J}:settle`]),
      'a job settles once — completing and cancelling must not both post');
  });

  test('different jobs and tips do not collide', () => {
    assert.notEqual(
      tip({ userId: U, jobId: J, providerId: P, tipId: 't1', amount: 100 }).idempotencyKey,
      tip({ userId: U, jobId: J, providerId: P, tipId: 't2', amount: 100 }).idempotencyKey);
  });
});

describe('zero-entry filtering removes only exact zeroes', () => {
  const build = amount => () => assertBalanced('T', [debit('A', amount), credit('B', amount)]
    .filter(e => e.amount !== 0));

  test('NaN still fails loudly', () => assert.throws(build(NaN), /positive integer cents/));
  test('a negative amount still fails loudly', () => assert.throws(build(-100), /positive integer cents/));
  test('a fractional amount still fails loudly', () => assert.throws(build(10.5), /positive integer cents/));
  test('undefined still fails loudly', () => assert.throws(build(undefined), /positive integer cents/));
  test('a numeric string still fails loudly', () => assert.throws(build('100'), /positive integer cents/));
  test('Infinity still fails loudly', () => assert.throws(build(Infinity), /positive integer cents/));

  test('a posting reduced below two entries is refused', () => {
    assert.throws(
      () => assertBalanced('T', [debit('A', 100), credit('B', 100), credit('C', 0)]
        .filter(e => e.amount !== 0 && e.account === 'A')),
      /at least two/);
  });

  test('a posting still balances after zero lines are dropped', () => {
    const t = jobCompleted({ userId: U, jobId: J, providerId: P, paymentId: PAY, bidAmount: 1 });
    assert.equal(t.entries.length, 2);
    assert.equal(t.entries.reduce((s, e) => s + signed(e), 0), 0);
    assert.ok(t.entries.every(e => e.amount > 0));
  });
});
