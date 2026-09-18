/**
 * Value presets — the user's own property queries, run alongside the mapping.
 *
 * The CORENET X mapping says which properties must exist and which values it
 * accepts. A preset says something the mapping does not: "every fire door on
 * this job has FireRating 60", "no wall is left with a blank Mark". Each one is
 * a selector (which elements) plus a condition (what one property must satisfy).
 *
 * Everything here is pure: index and preset in, results out. Where presets are
 * stored lives in preset-store.js, and the editor in preset-editor.js.
 */

import {
  canonicalEntity, getValue, findPset, formatValue, isEmptyValue,
} from '../../ifcsg.js';

/**
 * @typedef {object} ValuePreset
 * @property {string} id
 * @property {string} name
 * @property {string} entity    IFC entity, e.g. "IfcDoor". Standard-case variants fold onto it.
 * @property {string} subtype   Comma-separated PredefinedType / ObjectType values; '' for any.
 * @property {string} pset
 * @property {string} prop
 * @property {string} op        One of OPS.
 * @property {string} value     Operand; a comma-separated list for 'one-of'.
 * @property {boolean} enabled  Whether the IFC values check runs it.
 */

/** Conditions a property can be tested against, in menu order. */
export const OPS = [
  { id: 'exists', label: 'exists', needsValue: false },
  { id: 'not-empty', label: 'has a value', needsValue: false },
  { id: 'equals', label: 'equals', needsValue: true },
  { id: 'not-equals', label: 'does not equal', needsValue: true },
  { id: 'one-of', label: 'is one of', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
  { id: 'matches', label: 'matches pattern', needsValue: true },
  { id: 'gt', label: '>', needsValue: true, numeric: true },
  { id: 'gte', label: '≥', needsValue: true, numeric: true },
  { id: 'lt', label: '<', needsValue: true, numeric: true },
  { id: 'lte', label: '≤', needsValue: true, numeric: true },
];

const OP_BY_ID = new Map(OPS.map((o) => [o.id, o]));

/** Outcomes of testing one element. Everything but PASS is a failure. */
export const RESULT = {
  PASS: 'pass',
  MISSING: 'missing',     // the property set or the property is not on the element
  FAIL: 'fail',           // present, but the condition does not hold
};

export const RESULT_LABEL = {
  [RESULT.PASS]: 'Meets preset',
  [RESULT.MISSING]: 'Property missing',
  [RESULT.FAIL]: 'Does not meet preset',
};

export const RESULT_COLOUR = {
  [RESULT.PASS]: 0x5aa65a,
  [RESULT.MISSING]: 0xc4563c,
  [RESULT.FAIL]: 0xd4a13c,
};

const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
const splitList = (s) => String(s || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/** Fills defaults and drops unknown fields, so stored data has one shape. */
export function normalisePreset(p) {
  return {
    id: String(p.id || newId()),
    name: String(p.name || '').trim(),
    entity: String(p.entity || '').trim(),
    subtype: String(p.subtype || '').trim(),
    pset: String(p.pset || '').trim(),
    prop: String(p.prop || '').trim(),
    op: OP_BY_ID.has(p.op) ? p.op : 'exists',
    value: String(p.value == null ? '' : p.value).trim(),
    enabled: p.enabled !== false,
  };
}

export function newId() {
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Why a preset cannot run, or null when it can. */
export function validatePreset(p) {
  if (!p.name) return 'Give the preset a name.';
  if (!p.entity) return 'Choose an IFC entity.';
  if (!/^ifc[a-z0-9]+$/i.test(p.entity)) return `"${p.entity}" is not an IFC entity name.`;
  if (!p.pset) return 'Enter a property set.';
  if (!p.prop) return 'Enter a property.';
  const op = OP_BY_ID.get(p.op);
  if (!op) return 'Choose a condition.';
  if (op.needsValue && p.value === '') return `"${op.label}" needs a value.`;
  if (op.numeric && !Number.isFinite(Number(p.value))) return `"${op.label}" needs a number.`;
  if (p.op === 'matches') {
    try {
      new RegExp(p.value, 'i');
    } catch (err) {
      return `The pattern is not valid: ${err.message}`;
    }
  }
  return null;
}

/** Upper-case canonical entity the preset selects, e.g. 'IFCDOOR'. */
export function presetEntity(p) {
  return canonicalEntity(p.entity);
}

/** Does the preset's selector pick out this element? */
export function matchesPreset(el, p) {
  if (el.canonicalEntity !== presetEntity(p)) return false;
  const subtypes = splitList(p.subtype).map(norm);
  return !subtypes.length ||
    subtypes.includes(norm(el.predefinedType)) || subtypes.includes(norm(el.objectType));
}

/** Elements the preset's selector picks out, before any condition is tested. */
export function selectPresetElements(index, p) {
  const bucket = (index && index.byEntity.get(presetEntity(p))) || [];
  return bucket.filter((el) => matchesPreset(el, p));
}

/**
 * Tests one element against a preset's condition.
 * @returns {{result: string, value: *, detail: string}}
 */
export function testElement(el, p) {
  const op = OP_BY_ID.get(p.op) || OP_BY_ID.get('exists');
  if (!findPset(el, p.pset)) {
    return { result: RESULT.MISSING, value: undefined, detail: `no ${p.pset}` };
  }
  const value = getValue(el, p.pset, p.prop);
  if (value === undefined) {
    return { result: RESULT.MISSING, value, detail: `no ${p.prop}` };
  }
  if (op.id === 'exists') return { result: RESULT.PASS, value, detail: '' };

  const empty = isEmptyValue(value);
  const text = formatValue(value).trim();
  const expected = p.value;
  let ok;

  switch (op.id) {
    case 'not-empty': ok = !empty; break;
    case 'equals': ok = !empty && norm(text) === norm(expected); break;
    case 'not-equals': ok = norm(text) !== norm(expected); break;
    case 'one-of': ok = !empty && splitList(expected).map(norm).includes(norm(text)); break;
    case 'contains': ok = !empty && norm(text).includes(norm(expected)); break;
    case 'matches': {
      try {
        ok = !empty && new RegExp(expected, 'i').test(text);
      } catch {
        ok = false;
      }
      break;
    }
    default: {
      const n = Number(text);
      const m = Number(expected);
      if (empty || !Number.isFinite(n)) {
        return { result: RESULT.FAIL, value, detail: 'not a number' };
      }
      ok = op.id === 'gt' ? n > m : op.id === 'gte' ? n >= m : op.id === 'lt' ? n < m : n <= m;
    }
  }

  return ok
    ? { result: RESULT.PASS, value, detail: '' }
    : { result: RESULT.FAIL, value, detail: empty ? 'empty' : `is ${text}` };
}

/**
 * Runs one preset over the index.
 * @returns {{preset: ValuePreset, elements: object[], rows: Array, byResult: Object<string, object[]>}}
 */
export function runPreset(index, p) {
  const elements = selectPresetElements(index, p);
  const rows = [];
  const byResult = { [RESULT.PASS]: [], [RESULT.MISSING]: [], [RESULT.FAIL]: [] };
  for (const el of elements) {
    const r = testElement(el, p);
    rows.push({ element: el, ...r });
    byResult[r.result].push(el);
  }
  return { preset: p, elements, rows, byResult };
}

/** One-line reading of a preset, e.g. `IfcDoor [FIREDOOR] · Pset_DoorCommon.FireRating = 60`. */
export function describePreset(p) {
  const op = OP_BY_ID.get(p.op);
  const sel = p.entity + (p.subtype ? ` [${p.subtype}]` : '');
  const cond = op
    ? `${op.label}${op.needsValue ? ' ' + p.value : ''}`
    : p.op;
  return `${sel} · ${p.pset}.${p.prop} ${cond}`;
}

// ------------------------------------------------------------- model lookups

/**
 * What property sets and properties the selected elements actually carry, so the
 * editor can suggest names that exist rather than ones the user has to guess.
 * @returns {Array<{pset: string, props: string[], count: number}>}
 */
export function psetCatalog(elements) {
  const psets = new Map();
  for (const el of elements) {
    for (const [name, props] of Object.entries(el.psets)) {
      let entry = psets.get(name);
      if (!entry) psets.set(name, (entry = { pset: name, props: new Set(), count: 0 }));
      entry.count++;
      for (const k of Object.keys(props)) entry.props.add(k);
    }
  }
  return [...psets.values()]
    .map((e) => ({ pset: e.pset, props: [...e.props].sort(), count: e.count }))
    .sort((a, b) => b.count - a.count || a.pset.localeCompare(b.pset));
}

/**
 * Distinct values of one property across elements, most common first.
 * Elements without the property are counted under `missing`.
 * @returns {{values: Array<{label: string, count: number, elements: object[]}>, missing: object[]}}
 */
export function distinctValues(elements, pset, prop) {
  const values = new Map();
  const missing = [];
  for (const el of elements) {
    const v = getValue(el, pset, prop);
    if (v === undefined) {
      missing.push(el);
      continue;
    }
    const label = isEmptyValue(v) ? '(empty)' : formatValue(v).trim();
    let entry = values.get(label);
    if (!entry) values.set(label, (entry = { label, count: 0, elements: [] }));
    entry.count++;
    entry.elements.push(el);
  }
  return {
    values: [...values.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    missing,
  };
}

/** Distinct subtypes (PredefinedType / ObjectType) among an entity's elements. */
export function subtypeCatalog(index, entity) {
  const bucket = (index && index.byEntity.get(canonicalEntity(entity))) || [];
  const seen = new Map();
  for (const el of bucket) {
    for (const v of [el.predefinedType, el.objectType]) {
      if (v === null || v === undefined || v === '' || v === 'NOTDEFINED') continue;
      seen.set(String(v), (seen.get(String(v)) || 0) + 1);
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}
