/**
 * BCA requirements check.
 *
 * The module is the wiring only — every rule lives in ./rules.js, and the
 * evaluation, counting and rendering come from the shared authority kit. That
 * is deliberate: when the BCA rules are specified, the change is an edit to a
 * data file, with no control flow to get wrong.
 */

import { createAuthorityCheck } from '../authority-kit.js';
import { RULES } from './rules.js';

export default createAuthorityCheck({
  authority: 'BCA',
  rules: RULES,
  note: 'Evaluated from the model as submitted. A rule the model cannot answer is ' +
    'reported as not evaluated rather than passed.',
});
