/**
 * Runs a selection of checks against the loaded model.
 *
 * Checks run one at a time rather than in parallel: they are CPU-bound on the
 * main thread, so overlapping them would only make the progress meaningless and
 * the UI less responsive. The yield between checks is what keeps the page alive
 * — without it the browser paints nothing until every check has finished.
 */

import { load, byId } from './registry.js';

/** Lets the browser paint between checks. */
const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * @typedef {object} RunOutcome
 * @property {string} id
 * @property {object} meta    manifest entry
 * @property {import('./types.js').CheckResult|null} result
 * @property {Error|null} error   set when the check threw or failed to load
 * @property {number} ms          wall-clock time for this check
 */

/**
 * @param {string[]} ids   check ids, in the order to run them
 * @param {import('./types.js').CheckContext} ctx
 * @param {(msg: string, pct: number) => void} [onProgress]
 * @returns {Promise<RunOutcome[]>}  one entry per requested check, in order
 */
export async function runChecks(ids, ctx, onProgress = () => {}) {
  const outcomes = [];

  for (const [i, id] of ids.entries()) {
    if (ctx.signal && ctx.signal.aborted) break;

    const meta = byId(id);
    const base = (i / ids.length) * 100;
    const span = 100 / ids.length;
    const started = performance.now();

    onProgress('Loading ' + (meta ? meta.title : id) + '…', base);

    try {
      const module = await load(id);
      if (ctx.signal && ctx.signal.aborted) break;

      onProgress('Running ' + meta.title + '…', base + span * 0.2);
      await yieldToBrowser();

      const result = await module.run({
        ...ctx,
        // Inputs are declared per check, so each one sees only its own.
        inputs: ctx.inputsFor ? ctx.inputsFor(id) : (ctx.inputs || {}),
        progress: (msg, pct = 0) => onProgress(msg, base + span * (0.2 + (pct / 100) * 0.8)),
      });

      outcomes.push({ id, meta, result, error: null, ms: performance.now() - started });
    } catch (err) {
      // One failing check must not take the others down with it — report it in
      // place and carry on, so a partial result is still useful.
      console.error('Check "' + id + '" failed:', err);
      outcomes.push({ id, meta, result: null, error: err, ms: performance.now() - started });
    }

    await yieldToBrowser();
  }

  onProgress('Done', 100);
  return outcomes;
}

/** Every finding across a set of outcomes, tagged with the check it came from. */
export function allFindings(outcomes) {
  const findings = [];
  for (const o of outcomes) {
    const list = (o.result && o.result.findings) || [];
    for (const f of list) findings.push({ ...f, checkId: o.id });
  }
  return findings;
}

/** Combined headline numbers across a set of outcomes. */
export function totalsOf(outcomes) {
  const totals = { elements: 0, assertions: 0, pass: 0, fail: 0, checks: 0, failed: 0 };
  const elements = new Set();

  for (const o of outcomes) {
    if (o.error) {
      totals.failed++;
      continue;
    }
    if (!o.result) continue;

    totals.checks++;
    const s = o.result.summary || {};
    totals.assertions += s.assertions || 0;
    totals.pass += s.pass || 0;
    totals.fail += s.fail || 0;

    // Elements are unioned across checks so an element two checks both looked
    // at is counted once.
    for (const key of s.elementKeys || []) elements.add(key);
    for (const f of o.result.findings || []) if (f.element) elements.add(f.element.key);
  }

  totals.elements = elements.size;
  return totals;
}
