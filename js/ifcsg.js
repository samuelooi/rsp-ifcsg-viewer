/**
 * IFC-SG domain logic: the authority ruleset, the model property index, and the
 * compliance evaluation that joins the two.
 *
 * The ruleset in data/ifcsg-rules.json is generated from the CORENET X industry
 * mapping workbook by tools/build-ifcsg-rules.ps1. That workbook is the source of
 * truth the agencies query models against, so nothing here hard-codes rules —
 * everything is driven by that file.
 */

// ---------------------------------------------------------------------------
// Entity aliases
// ---------------------------------------------------------------------------

/**
 * The mapping names base IFC4 entities, but authoring tools routinely export the
 * "standard case" specialisations (Revit emits IfcWallStandardCase for most
 * walls). Those are the same building component as far as the mapping is
 * concerned, so fold them onto the base entity before matching.
 */
export const ENTITY_ALIASES = new Map(Object.entries({
  IFCWALLSTANDARDCASE: 'IFCWALL',
  IFCWALLELEMENTEDCASE: 'IFCWALL',
  IFCSLABSTANDARDCASE: 'IFCSLAB',
  IFCSLABELEMENTEDCASE: 'IFCSLAB',
  IFCBEAMSTANDARDCASE: 'IFCBEAM',
  IFCCOLUMNSTANDARDCASE: 'IFCCOLUMN',
  IFCDOORSTANDARDCASE: 'IFCDOOR',
  IFCWINDOWSTANDARDCASE: 'IFCWINDOW',
  IFCMEMBERSTANDARDCASE: 'IFCMEMBER',
  IFCPLATESTANDARDCASE: 'IFCPLATE',
  IFCROOFSTANDARDCASE: 'IFCROOF',
}));

/** Upper-cases an entity name and folds standard-case variants onto their base. */
export function canonicalEntity(name) {
  if (!name) return '';
  const upper = String(name).toUpperCase();
  return ENTITY_ALIASES.get(upper) || upper;
}

const eq = (a, b) =>
  a != null && b != null && String(a).trim().toUpperCase() === String(b).trim().toUpperCase();

// ---------------------------------------------------------------------------
// Agencies
// ---------------------------------------------------------------------------

/**
 * The workbook's "All" agency: a component every authority queries, rather
 * than an authority of its own. Upper-cased by the build like every agency.
 */
export const AGENCY_ALL = 'ALL';

/** Does a target fall under an authority filter? '' means any authority. */
export function appliesToAgency(target, agency) {
  return !agency || target.agency === agency || target.agency === AGENCY_ALL;
}

// ---------------------------------------------------------------------------
// CX submission gateway
// ---------------------------------------------------------------------------

/**
 * Which CORENET X submission gateway a requirement belongs to.
 *
 * The authority workbook has no such column; RSP adds a "Gateway" column
 * (DG / CG) to its copy, and tools/build-ifcsg-rules.ps1 carries it through as
 * `rule.gateway`. The Construction Gateway is checked for everything, so a row
 * marked DG belongs to both gateways and a row marked CG only to Construction.
 * It is per row: within one component the Design Gateway can ask for fewer
 * properties, so a component is indexed as one target per gateway.
 */
export const GATEWAY = {
  DESIGN: 'design',
  CONSTRUCTION: 'construction',
};

export const GATEWAY_LABEL = {
  [GATEWAY.DESIGN]: 'Design Gateway',
  [GATEWAY.CONSTRUCTION]: 'Construction Gateway',
};

/** Display order, the stricter gateway last. */
export const GATEWAY_ORDER = [GATEWAY.DESIGN, GATEWAY.CONSTRUCTION];

/**
 * The gateways a workbook row belongs to. A row with the column blank is
 * treated as CG: the authorities check everything at the Construction Gateway.
 */
function gatewaysOf(rule) {
  return rule.gateway === GATEWAY.DESIGN
    ? [GATEWAY.DESIGN, GATEWAY.CONSTRUCTION]
    : [GATEWAY.CONSTRUCTION];
}

// ---------------------------------------------------------------------------
// Ruleset
// ---------------------------------------------------------------------------

/** Fetches an optional JSON file; a missing or unreadable file yields null. */
async function fetchOptionalJson(url) {
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Loads and indexes the generated ruleset, plus the optional URA vocabulary
 * overlay. If the overlay is missing, the workbook's own lists still apply.
 * @returns {Promise<Ruleset>}
 */
export async function loadRuleset(
  url = 'data/ifcsg-rules.json',
  overlayUrl = 'data/ura-vocabulary.json',
) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Could not load the IFC-SG ruleset (${res.status} ${res.statusText}).`);

  // The agencies publish vocabulary in more than one place and the lists do not
  // always agree. The overlay carries what URA accepts but the workbook does
  // not, so a value the authority would pass is not reported here as invalid.
  const [raw, overlay] = await Promise.all([res.json(), fetchOptionalJson(overlayUrl)]);

  return indexRuleset(raw, overlay);
}

/**
 * Adds overlay values to the Space Values lists, skipping any the workbook
 * already carries. Comparison ignores case and spacing, matching how the
 * authority says it reads these values.
 * @returns {{added: number, properties: string[]}}
 */
function mergeVocabulary(spaceValues, overlay) {
  const report = { added: 0, properties: [] };
  if (!overlay || !overlay.spaceValues) return report;

  const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();

  for (const [prop, values] of Object.entries(overlay.spaceValues)) {
    if (!Array.isArray(values) || !values.length) continue;
    const list = spaceValues[prop] || (spaceValues[prop] = []);
    const seen = new Set(list.map((v) => squash(v.value)));

    for (const entry of values) {
      const value = entry && entry.value;
      if (!value || seen.has(squash(value))) continue;
      seen.add(squash(value));
      // `source` marks where a value came from, so the inspector can say that a
      // value passed on URA's list rather than the workbook's.
      list.push({ value, scope: entry.scope || null, source: 'URA' });
      report.added++;
      if (!report.properties.includes(prop)) report.properties.push(prop);
    }
  }
  return report;
}

/**
 * Groups the flat rule rows into the component-level structure the UI presents.
 *
 * A "target" is one (gateway, agency, component, entity, subtypes) selector —
 * the thing a query isolates. Its requirements are the property rows the
 * mapping attaches to it. The workbook splits one component across several
 * rows with identical selectors, so rows are keyed by selector identity to
 * recombine them. Gateway is part of that identity: the Design Gateway can ask
 * for a subset of a component's properties, and that subset is its own target.
 */
export function indexRuleset(raw, overlay = null) {
  const spaceValues = raw.spaceValues || {};
  const vocabulary = mergeVocabulary(spaceValues, overlay);

  const targets = new Map();

  for (const rule of raw.rules) {
    // Subtype lists are per-row; the selector identity includes them so that,
    // e.g., IfcDamper/SMOKEDAMPER and IfcDamper/FIRESMOKEDAMPER stay distinct.
    const subKey = rule.subtypes.map((s) => (s.anySubtype ? '*' : (s.userDefined ? '*' : '') + s.value)).sort().join(',');
    for (const gateway of gatewaysOf(rule)) {
      const key = [gateway, rule.agency, rule.component, rule.entity, subKey].join('\u0000');

      let target = targets.get(key);
      if (!target) {
        target = {
          id: 't' + targets.size,
          gateway,
          agency: rule.agency,
          component: rule.component,
          discipline: rule.discipline,
          entity: rule.entity,
          canonicalEntity: canonicalEntity(rule.entity),
          subtypes: rule.subtypes,
          requirements: [],
        };
        targets.set(key, target);
      }
      if (rule.kind === 'requirement') target.requirements.push(rule);
    }
  }

  const targetList = [...targets.values()];
  for (const t of targetList) {
    t.requirements.sort((a, b) =>
      (a.pset + a.prop).localeCompare(b.pset + b.prop, undefined, { sensitivity: 'base' }));
  }
  targetList.sort((a, b) =>
    GATEWAY_ORDER.indexOf(a.gateway) - GATEWAY_ORDER.indexOf(b.gateway) ||
    a.agency.localeCompare(b.agency) ||
    a.component.localeCompare(b.component) ||
    a.entity.localeCompare(b.entity));

  // Entities the ruleset cares about, so the model index can skip everything else.
  const entityCodes = new Set(targetList.map((t) => t.canonicalEntity));

  // The workbook spells entities properly ("IfcBuildingElementProxy"); keep that
  // casing for display rather than re-deriving it from the upper-case schema name.
  const entityDisplay = new Map();
  for (const name of raw.entities) entityDisplay.set(name.toUpperCase(), name);

  return {
    meta: raw.meta,
    agencies: raw.agencies,
    disciplines: raw.disciplines,
    spaceValues,
    vocabulary,
    rules: raw.rules,
    targets: targetList,
    entities: entityCodes,
    entityDisplay,
  };
}

/** Human-readable subtype list, restoring the workbook's `*` USERDEFINED marker. */
export function describeSubtypes(subtypes) {
  if (!subtypes || !subtypes.length) return 'any subtype';
  if (subtypes.some((s) => s.anySubtype)) return 'all subtypes in COP';
  return subtypes.map((s) => (s.userDefined ? '*' : '') + s.value).join(', ');
}

// ---------------------------------------------------------------------------
// Element matching
// ---------------------------------------------------------------------------

/**
 * Does one model element satisfy a target's entity + subtype selector?
 *
 * A `*` subtype in the workbook means the IFC PredefinedType is USERDEFINED and
 * the real name is carried on ObjectType. Exporters are inconsistent about this,
 * so both fields are accepted for user-defined subtypes.
 */
export function matchesTarget(el, target) {
  if (el.canonicalEntity !== target.canonicalEntity) return false;

  const subs = target.subtypes;
  if (!subs.length || subs.some((s) => s.anySubtype)) return true;

  return subs.some((s) => {
    if (s.userDefined) return eq(el.objectType, s.value) || eq(el.predefinedType, s.value);
    return eq(el.predefinedType, s.value);
  });
}

/** All indexed elements selected by a target. */
export function selectElements(index, target) {
  const bucket = index.byEntity.get(target.canonicalEntity);
  if (!bucket) return [];
  return bucket.filter((el) => matchesTarget(el, target));
}

// ---------------------------------------------------------------------------
// Property lookup
// ---------------------------------------------------------------------------

/** Case-insensitive property-set lookup, since exporters vary on casing. */
export function findPset(el, name) {
  if (!name) return null;
  const direct = el.psets[name];
  if (direct) return direct;
  const wanted = name.toUpperCase();
  for (const key of Object.keys(el.psets)) {
    if (key.toUpperCase() === wanted) return el.psets[key];
  }
  return null;
}

export function findProp(pset, name) {
  if (!pset || !name) return undefined;
  if (name in pset) return pset[name];
  const wanted = name.toUpperCase();
  for (const key of Object.keys(pset)) {
    if (key.toUpperCase() === wanted) return pset[key];
  }
  return undefined;
}

/** The value of `pset.prop` on an element, or undefined if either is absent. */
export function getValue(el, psetName, propName) {
  return findProp(findPset(el, psetName), propName);
}

/**
 * Renders a property value for display.
 *
 * Booleans read as "True" / "False" rather than JS's lower-case `true`/`false`
 * or the raw STEP "T"/"F", so legends, the inspector and the check report all
 * present them the way the mapping writes them.
 */
export function formatValue(v) {
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return formatNumber(v);
  // Exporters sometimes write numbers as text, noise included.
  if (typeof v === 'string' && /^\s*-?\d+\.\d{7,}\s*$/.test(v)) return formatNumber(Number(v));
  return String(v);
}

/**
 * A number as the modeller typed it. Float arithmetic in exporters leaves
 * 1800.0000000000002 where 1800 was drawn; rounding to three decimals removes
 * that noise while keeping genuine precision such as 0.125.
 */
export function formatNumber(n) {
  if (!Number.isFinite(n)) return String(n);
  return String(Math.round(n * 1000) / 1000);
}

/** True when a property carries no usable value. `false` is a value, not a gap. */
export function isEmptyValue(v) {
  return v === undefined || v === null || (typeof v !== 'boolean' && String(v).trim() === '');
}

// ---------------------------------------------------------------------------
// Compliance evaluation
// ---------------------------------------------------------------------------

export const STATUS = {
  PASS: 'pass',
  MISSING_PSET: 'missing-pset',
  MISSING_PROP: 'missing-prop',
  EMPTY: 'empty',
  INVALID_VALUE: 'invalid-value',
  INVALID_TYPE: 'invalid-type',
};

export const STATUS_LABEL = {
  [STATUS.PASS]: 'Compliant',
  [STATUS.MISSING_PSET]: 'Property set missing',
  [STATUS.MISSING_PROP]: 'Property missing',
  [STATUS.EMPTY]: 'Value empty',
  [STATUS.INVALID_VALUE]: 'Value not in accepted list',
  [STATUS.INVALID_TYPE]: 'Wrong data type',
};

const NUMERIC_TYPES = new Set(['Length', 'Area', 'Volume', 'Integer', 'Real', 'VolumetricFlowRate']);

function isBooleanish(v) {
  return ['TRUE', 'FALSE', '1', '0', 'YES', 'NO', 'T', 'F'].includes(String(v).trim().toUpperCase());
}

/**
 * Evaluates one requirement against one element.
 * @returns {{status: string, value: *, detail: string|null}}
 */
export function evaluate(el, req, ruleset) {
  const pset = findPset(el, req.pset);
  if (!pset) return { status: STATUS.MISSING_PSET, value: undefined, detail: req.pset };

  const value = findProp(pset, req.prop);
  if (value === undefined) return { status: STATUS.MISSING_PROP, value: undefined, detail: req.prop };

  if (isEmptyValue(value)) return { status: STATUS.EMPTY, value, detail: null };

  const text = String(value).trim();
  const acc = req.accepted || { kind: 'any', values: [] };

  switch (acc.kind) {
    case 'boolean':
      return isBooleanish(text)
        ? { status: STATUS.PASS, value, detail: null }
        : { status: STATUS.INVALID_VALUE, value, detail: 'expected TRUE or FALSE' };

    case 'enum': {
      const ok = acc.values.some((v) => eq(v, text));
      return ok
        ? { status: STATUS.PASS, value, detail: null }
        : { status: STATUS.INVALID_VALUE, value, detail: `accepted: ${acc.values.join(', ')}` };
    }

    case 'spaceValues': {
      // The workbook defers to the Space Values sheet, keyed by property name.
      const allowed = ruleset.spaceValues[req.prop];
      if (!allowed) return { status: STATUS.PASS, value, detail: null };
      const ok = allowed.some((v) => eq(v.value, text));
      return ok
        ? { status: STATUS.PASS, value, detail: null }
        : { status: STATUS.INVALID_VALUE, value, detail: `not in Space Values list for ${req.prop}` };
    }

    case 'positiveNumber': {
      const n = Number(text);
      return Number.isFinite(n) && n > 0
        ? { status: STATUS.PASS, value, detail: null }
        : { status: STATUS.INVALID_VALUE, value, detail: 'expected a positive number' };
    }

    default: {
      // No enumeration given — fall back to checking the declared data type.
      if (NUMERIC_TYPES.has(req.dataType) && !Number.isFinite(Number(text))) {
        return { status: STATUS.INVALID_TYPE, value, detail: `expected ${req.dataType}` };
      }
      if (req.dataType === 'Boolean' && !isBooleanish(text)) {
        return { status: STATUS.INVALID_TYPE, value, detail: 'expected Boolean' };
      }
      return { status: STATUS.PASS, value, detail: null };
    }
  }
}

/**
 * Runs every requirement of every target that has matching elements in the model.
 * @returns {{targets: Array, totals: Object}} per-target results plus a summary.
 */
export function runCheck(index, ruleset, filter = () => true) {
  const results = [];
  const totals = { elements: 0, checks: 0, pass: 0, fail: 0, byStatus: {} };

  for (const target of ruleset.targets) {
    if (!filter(target)) continue;

    const elements = selectElements(index, target);
    if (!elements.length) continue;

    const issues = [];
    let pass = 0;
    let fail = 0;

    for (const el of elements) {
      for (const req of target.requirements) {
        const r = evaluate(el, req, ruleset);
        totals.checks++;
        totals.byStatus[r.status] = (totals.byStatus[r.status] || 0) + 1;
        if (r.status === STATUS.PASS) {
          pass++;
          totals.pass++;
        } else {
          fail++;
          totals.fail++;
          issues.push({ element: el, req, ...r });
        }
      }
    }

    totals.elements += elements.length;
    results.push({ target, elements, issues, pass, fail });
  }

  results.sort((a, b) => b.fail - a.fail || b.elements.length - a.elements.length);
  return { targets: results, totals };
}

/**
 * Buckets a target's elements by the value of one property, for colour-by-value.
 * Elements missing the property land in a dedicated "(not set)" bucket so the
 * gap is visible rather than silently absent.
 */
export function groupByValue(elements, req) {
  const groups = new Map();
  for (const el of elements) {
    const v = getValue(el, req.pset, req.prop);
    const missing = isEmptyValue(v);
    const label = missing ? '(not set)' : formatValue(v).trim();
    let g = groups.get(label);
    if (!g) {
      g = { label, value: missing ? null : v, elements: [], missing };
      groups.set(label, g);
    }
    g.elements.push(el);
  }
  // Ascending by value — numerically when every value is a number, otherwise
  // alphabetically with embedded numbers in order (B2 before B10). "(not set)"
  // always comes last so it reads as the exception.
  const list = [...groups.values()];
  const numeric = list.every((g) => g.missing || Number.isFinite(Number(g.label)));
  return list.sort((a, b) => {
    if (a.missing !== b.missing) return a.missing ? 1 : -1;
    if (numeric) return Number(a.label) - Number(b.label);
    return a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' });
  });
}
