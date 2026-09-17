/**
 * BCA building rules.
 *
 * **Empty on purpose.** Nothing is listed here yet because the rules have not
 * been specified — inventing plausible-looking accessibility requirements would
 * be worse than reporting none, since a wrong rule that runs silently reads as
 * an authoritative result.
 *
 * Add rules as objects in this array. The shape is documented on AuthorityRule
 * in ../authority-kit.js; the example below shows a complete one. Nothing else
 * in the app needs to change when a rule is added.
 *
 * @example
 * import { SEVERITY } from '../severity.js';
 * import { getValue } from '../../ifcsg.js';
 *
 * export const RULES = [
 *   {
 *     id: 'bca-accessible-route-width',
 *     title: 'Accessible routes meet the minimum clear width',
 *     reference: 'BCA — barrier-free accessibility',
 *     severity: SEVERITY.FAIL,
 *     select: (ctx) => (ctx.index.byEntity.get('IFCSPACE') || [])
 *       .filter((el) => String(el.objectType || '').toUpperCase() === 'ACCESSIBLEROUTE'),
 *     assert: (el) => {
 *       const width = Number(getValue(el, 'SGPset_SpaceDimension', 'Width'));
 *       if (!Number.isFinite(width)) return 'Width is not set, so it cannot be checked.';
 *       // The threshold belongs to the published requirement, not to this example.
 *       return width >= MINIMUM_WIDTH_MM
 *         ? true
 *         : `Width is ${width} mm, below the ${MINIMUM_WIDTH_MM} mm minimum.`;
 *     },
 *   },
 * ];
 */

/** @type {import('../authority-kit.js').AuthorityRule[]} */
export const RULES = [];
