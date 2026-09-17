/**
 * The one vocabulary every check module shares.
 *
 * A module reports findings in its own terms — "Property set missing", "setback
 * below minimum" — but the shell has to count, colour and sort findings from
 * modules it knows nothing about. So every finding carries a `severity` from
 * this fixed set alongside its module-specific `code` and `label`.
 *
 * Severity answers "how bad", the code answers "what". Keep the codes rich; the
 * severities deliberately stay coarse.
 */

export const SEVERITY = {
  /** Checked and satisfied. */
  PASS: 'pass',
  /** Worth reporting, not a defect — e.g. a value taken from a fallback property. */
  INFO: 'info',
  /** Non-compliant in a way that may be intentional, or that the mapping leaves open. */
  WARN: 'warn',
  /** Non-compliant. This is what an authority would reject. */
  FAIL: 'fail',
};

export const SEVERITY_LABEL = {
  [SEVERITY.PASS]: 'Compliant',
  [SEVERITY.INFO]: 'For information',
  [SEVERITY.WARN]: 'Review',
  [SEVERITY.FAIL]: 'Non-compliant',
};

/** Same hues the viewer already uses, so a colour means the same thing everywhere. */
export const SEVERITY_COLOUR = {
  [SEVERITY.PASS]: 0x5aa65a,
  [SEVERITY.INFO]: 0x4fa3d1,
  [SEVERITY.WARN]: 0xd4a13c,
  [SEVERITY.FAIL]: 0xd16a4f,
};

/** Best first, worst last: `worstOf` and the colour legend both rely on this order. */
export const SEVERITY_ORDER = [SEVERITY.PASS, SEVERITY.INFO, SEVERITY.WARN, SEVERITY.FAIL];

/** The worst severity in a list, or PASS when there is nothing to report. */
export function worstOf(severities) {
  let worst = SEVERITY.PASS;
  for (const s of severities) {
    if (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst)) worst = s;
  }
  return worst;
}

/** True when a severity counts against the model rather than merely describing it. */
export function isFailure(severity) {
  return severity === SEVERITY.FAIL || severity === SEVERITY.WARN;
}
