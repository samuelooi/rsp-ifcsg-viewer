/**
 * URA requirements check.
 *
 * The module is the wiring only — every rule lives in ./rules.js, and the
 * evaluation, counting and rendering come from the shared authority kit.
 *
 * The one thing it does decide is scope. URA runs two submission gateways with
 * materially different requirements: the Design Gateway asks for far less than
 * the Construction Gateway. The user picks which they are submitting for, and
 * rules belonging to the other gateway are not run and not reported — an
 * unasked rule is not the same as an unanswered one.
 */

import { createAuthorityCheck } from '../authority-kit.js';
import { RULES } from './rules.js';

/** Falls back to the stricter gateway, so a forgotten selection cannot under-report. */
export function gatewayOf(ctx) {
  const chosen = ctx && ctx.inputs && ctx.inputs.gateway;
  return chosen === 'design' ? 'design' : 'construction';
}

const LABEL = { design: 'Design Gateway', construction: 'Construction Gateway' };

export default createAuthorityCheck({
  authority: 'URA',
  rules: RULES,
  inScope: (rule, ctx) => !rule.gateways || rule.gateways.includes(gatewayOf(ctx)),
  note: (ctx) =>
    `Checked against the ${LABEL[gatewayOf(ctx)]}. Vocabulary is not re-checked here — ` +
    'those parameters are validated by the IFC values check, with URA\'s additional ' +
    'accepted values merged in. A rule the model cannot answer is reported as not ' +
    'evaluated rather than passed.',
});
