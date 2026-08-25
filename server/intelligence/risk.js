/**
 * RISK — assesses a payment intent before it reaches Hyperswitch.
 *
 * This layer never talks to the gateway. It reads the job, the customer's
 * history and the ledger, and returns signals the strategy layer consumes.
 * Kept separate so risk rules can change without touching payment code.
 */
export const LEVELS = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high' };

export function assess({ job, amount, history = {} }) {
  const signals = [];
  let score = 0;

  // A long gap between booking and service means the hold must survive longer.
  const hoursOut = job ? (new Date(job.scheduled_for) - Date.now()) / 3.6e6 : 0;
  if (hoursOut > 24) { score += 2; signals.push(`service is ${Math.round(hoursOut)}h away`); }
  else if (hoursOut > 6) { score += 1; signals.push('service is later today'); }

  // Large tickets deserve more scrutiny and are likelier to be disputed.
  if (amount > 50000) { score += 2; signals.push('high value'); }
  else if (amount > 20000) { score += 1; signals.push('above average value'); }

  if ((history.completedJobs ?? 0) === 0) { score += 1; signals.push('first job'); }

  // Prior chargebacks dominate everything else.
  if ((history.disputesRaised ?? 0) > 0) { score += 3; signals.push('has raised a dispute before'); }

  // A provider carrying a clawback is a settlement risk rather than a payment
  // one, but it belongs in the same assessment.
  if ((history.providerClawback ?? 0) > 0) { score += 1; signals.push('provider owes a clawback'); }

  const level = score >= 5 ? LEVELS.HIGH : score >= 2 ? LEVELS.MEDIUM : LEVELS.LOW;
  return {
    level, score, signals,
    // Long holds are the only reason to ask for extended authorization. Asking
    // for it on a job starting within the hour just adds a needless call.
    needsExtendedAuth: hoursOut > 12,
    // Step up only where the friction earns its keep.
    require3ds: level === LEVELS.HIGH,
  };
}
