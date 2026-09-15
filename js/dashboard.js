/**
 * Project dashboard: the headline quantities an architect reports to the
 * authorities, totalled across the federated model and broken down by file and
 * by storey.
 *
 * Every metric is defined against the CORENET X mapping, and the mapping row
 * each one comes from is quoted in `source` so a number can be traced back.
 * Where the mapping does not name a property (Site Coverage has none), the
 * candidates are searched in order and the one actually used is reported.
 */

import { getValue } from './ifcsg.js';

/**
 * Entities the dashboard needs indexed, regardless of the discipline scope the
 * ruleset was built with. IfcTank is MEP, so the architectural ruleset does not
 * mention it, but refuse capacity is reported by architects.
 */
export const DASHBOARD_ENTITIES = new Set([
  'IFCSPACE',
  'IFCGEOGRAPHICELEMENT',
  'IFCBUILDINGELEMENTPROXY',
  'IFCTANK',
]);

// ---------------------------------------------------------------- value access

const clean = (s) => String(s == null ? '' : s).trim().replace(/^\*/, '').toUpperCase();

/** The workbook marks USERDEFINED subtypes with `*`; the model carries the bare name. */
function hasSubtype(el, names) {
  if (!names || !names.length) return true;
  const want = names.map(clean);
  return want.includes(clean(el.objectType)) || want.includes(clean(el.predefinedType));
}

/** Which of the listed subtypes an element is, for per-type breakdowns. */
function subtypeOf(el, names) {
  const ot = clean(el.objectType);
  const pt = clean(el.predefinedType);
  for (const n of names) {
    const c = clean(n);
    if (c === ot || c === pt) return c;
  }
  return null;
}

/**
 * When a metric finds nothing, look for elements of the right entity whose
 * subtype is *close* to what the mapping asks for.
 *
 * A model that types its GFA spaces with the IFC4 `GFA` PredefinedType instead
 * of the mapping's USERDEFINED `AREA_GFA` produces an empty card that looks like
 * a tool failure. Reporting the near miss turns it into the finding it actually
 * is: the elements exist but are not typed the way the authority queries for.
 */
function nearMisses(pool, subtypes) {
  const squash = (s) => clean(s).replace(/[^A-Z0-9]/g, '');
  const want = subtypes.map(squash).filter(Boolean);
  const found = new Map();

  for (const el of pool) {
    for (const raw of [el.objectType, el.predefinedType]) {
      const c = squash(raw);
      if (!c || c === 'NOTDEFINED' || c === 'USERDEFINED') continue;
      if (!want.some((w) => w !== c && (w.includes(c) || c.includes(w)))) continue;
      const label = `ObjectType ${el.objectType || '—'} / PredefinedType ${el.predefinedType || '—'}`;
      found.set(label, (found.get(label) || 0) + 1);
      break;
    }
  }
  return [...found.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

function isTrue(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  return ['TRUE', 'T', 'YES', '1'].includes(String(v).trim().toUpperCase());
}

/**
 * First numeric value found among candidate `[pset, property]` pairs.
 * @returns {{value: number, source: string}|null}
 */
function firstNumber(el, candidates) {
  for (const [pset, prop] of candidates) {
    const v = getValue(el, pset, prop);
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return { value: n, source: `${pset}.${prop}` };
  }
  return null;
}

// Areas are declared in m² by the mapping. Quantity sets are the fallback when
// the SGPset property was not authored.
const SPACE_AREA = [
  ['SGPset_SpaceDimension', 'Area'],
  ['Qto_SpaceBaseQuantities', 'GrossFloorArea'],
  ['Qto_SpaceBaseQuantities', 'NetFloorArea'],
  ['BaseQuantities', 'GrossFloorArea'],
];
const GEO_AREA = [
  ['SGPset_GeographicElementDimension', 'Area'],
  ['Qto_GeographicElementBaseQuantities', 'GrossArea'],
  ['BaseQuantities', 'GrossArea'],
];
const PROXY_AREA = [
  ['SGPset_BuildingElementProxyDimension', 'Area'],
  ['Qto_BuildingElementProxyBaseQuantities', 'GrossArea'],
  ['Qto_BuildingElementProxyBaseQuantities', 'NetArea'],
  ['Qto_BuildingElementProxyBaseQuantities', 'CrossSectionArea'],
  ['BaseQuantities', 'GrossArea'],
];

const PARKING_TYPES = [
  '*CARLOT', '*MOTORCYCLELOT', '*LORRYLOT',
  '*COACHLOT', '*ARTICULATEDVEHICLELOT', '*BICYCLELOT',
];
const REFUSE_BINS = ['*RECYCLINGBIN', '*REFUSEBIN'];
const REFUSE_EQUIPMENT = [
  '*REFUSECONTAINER', '*REFUSECOMPACTOR', '*RECYCLABLECONTAINER',
  '*RECYCLABLECOMPACTOR', '*REFUSEHANDLINGEQUIPMENT',
];

const TITLE_CASE = {
  CARLOT: 'Car', MOTORCYCLELOT: 'Motorcycle', LORRYLOT: 'Lorry',
  COACHLOT: 'Coach', ARTICULATEDVEHICLELOT: 'Articulated vehicle', BICYCLELOT: 'Bicycle',
  RECYCLINGBIN: 'Recycling bin', REFUSEBIN: 'Refuse bin',
  REFUSECONTAINER: 'Refuse container', REFUSECOMPACTOR: 'Refuse compactor',
  RECYCLABLECONTAINER: 'Recyclable container', RECYCLABLECOMPACTOR: 'Recyclable compactor',
  REFUSEHANDLINGEQUIPMENT: 'Refuse handling equipment',
};
const pretty = (k) => TITLE_CASE[k] || k;

// --------------------------------------------------------------- metric specs

/**
 * `measure: null` counts elements; otherwise it sums the first numeric value
 * found among `candidates`.
 */
const METRICS = [
  {
    id: 'gfa',
    title: 'Gross Floor Area',
    unit: 'm²',
    decimals: 2,
    entity: 'IFCSPACE',
    subtypes: ['*AREA_GFA'],
    where: (el) => isTrue(getValue(el, 'SGPset_SpaceArea_Verification', 'AVF_IncludeAsGFA')),
    whereLabel: 'AVF_IncludeAsGFA = True',
    measure: SPACE_AREA,
    source: 'IfcSpace · ObjectType AREA_GFA · SGPset_SpaceArea_Verification.AVF_IncludeAsGFA',
  },
  {
    id: 'planting',
    title: 'Planting Areas',
    unit: 'm²',
    decimals: 2,
    entity: 'IFCGEOGRAPHICELEMENT',
    subtypes: ['*PLANTINGAREAS'],
    measure: GEO_AREA,
    // Encroachment and Compensated are Booleans in the mapping, so these are
    // areas of the flagged planting areas rather than separate quantities.
    subtotals: [
      { label: 'Encroachment', when: (el) => isTrue(getValue(el, 'SGPset_GeographicElement', 'Encroachment')) },
      { label: 'Compensated', when: (el) => isTrue(getValue(el, 'SGPset_GeographicElement', 'Compensated')) },
    ],
    source: 'IfcGeographicElement · *PLANTINGAREAS · SGPset_GeographicElementDimension.Area',
  },
  {
    id: 'parking',
    title: 'Parking Lots',
    unit: 'lots',
    decimals: 0,
    entity: 'IFCBUILDINGELEMENTPROXY',
    subtypes: PARKING_TYPES,
    measure: null,                 // a count, not a sum
    splitByType: PARKING_TYPES,
    source: 'IfcBuildingElementProxy · *CARLOT, *MOTORCYCLELOT, *LORRYLOT, *COACHLOT, *ARTICULATEDVEHICLELOT, *BICYCLELOT',
  },
  {
    id: 'refuse-bins',
    title: 'Refuse & Recycling Bins',
    unit: 'L',
    decimals: 0,
    entity: 'IFCTANK',
    subtypes: REFUSE_BINS,
    measure: [['SGPset_Tank', 'Litre']],
    splitByType: REFUSE_BINS,
    source: 'IfcTank · *RECYCLINGBIN, *REFUSEBIN · SGPset_Tank.Litre',
  },
  {
    id: 'refuse-equipment',
    title: 'Refuse Handling Equipment',
    unit: 'm³',
    decimals: 2,
    entity: 'IFCTANK',
    subtypes: REFUSE_EQUIPMENT,
    measure: [['Pset_TankTypeCommon', 'NominalCapacity'], ['SGPset_Tank', 'NominalCapacity']],
    splitByType: REFUSE_EQUIPMENT,
    source: 'IfcTank · *REFUSECONTAINER, *REFUSECOMPACTOR, *RECYCLABLECONTAINER, *RECYCLABLECOMPACTOR, *REFUSEHANDLINGEQUIPMENT · Pset_TankTypeCommon.NominalCapacity',
  },
  {
    id: 'site-coverage',
    title: 'Site Coverage',
    unit: 'm²',
    decimals: 2,
    entity: 'IFCBUILDINGELEMENTPROXY',
    subtypes: ['*SITECOVERAGE'],
    measure: PROXY_AREA,
    // The mapping declares no property for this subtype, so the area is taken
    // from whichever of the candidates the model actually carries.
    note: 'The mapping defines no area property for *SITECOVERAGE; the value is read from the property set the model provides.',
    source: 'IfcBuildingElementProxy · *SITECOVERAGE',
  },
  {
    id: 'site-area',
    title: 'Site Area',
    unit: 'm²',
    decimals: 2,
    entity: 'IFCGEOGRAPHICELEMENT',
    subtypes: ['*SITEBOUNDARY'],
    measure: GEO_AREA,
    source: 'IfcGeographicElement · *SITEBOUNDARY · SGPset_GeographicElementDimension.Area',
  },
];

// ------------------------------------------------------------------ computation

function addTo(map, key, value, count, el) {
  const row = map.get(key) || { label: key, value: 0, count: 0, elements: [] };
  row.value += value;
  row.count += count;
  // Element references are kept so a breakdown row can be shown in the 3D view.
  if (el) row.elements.push(el);
  map.set(key, row);
}

const byValueDesc = (a, b) => b.value - a.value || b.count - a.count || a.label.localeCompare(b.label);

/**
 * @param {object} index    merged model index
 * @param {Map<number,string>} modelNames  modelID -> file name
 */
export function computeDashboard(index, modelNames = new Map()) {
  const metrics = METRICS.map((spec) => {
    const pool = index ? (index.byEntity.get(spec.entity) || []) : [];
    const matched = pool.filter((el) => hasSubtype(el, spec.subtypes));
    const elements = spec.where ? matched.filter(spec.where) : matched;

    const byFile = new Map();
    const byLevel = new Map();
    const byType = new Map();
    const sources = new Set();

    let total = 0;
    let missingValue = 0;
    const subtotals = (spec.subtotals || []).map((s) => ({ label: s.label, value: 0, count: 0 }));

    for (const el of elements) {
      let v = 1;                                   // counting metric
      if (spec.measure) {
        const found = firstNumber(el, spec.measure);
        if (!found) { missingValue++; v = 0; }
        else { v = found.value; sources.add(found.source); }
      }
      total += v;

      addTo(byFile, modelNames.get(el.modelID) || `Model ${el.modelID}`, v, 1, el);
      addTo(byLevel, el.storey || '(no storey)', v, 1, el);
      if (spec.splitByType) {
        addTo(byType, pretty(subtypeOf(el, spec.splitByType) || 'Other'), v, 1, el);
      }
      (spec.subtotals || []).forEach((s, i) => {
        if (s.when(el)) { subtotals[i].value += v; subtotals[i].count++; }
      });
    }

    return {
      id: spec.id,
      title: spec.title,
      entity: spec.entity,
      unit: spec.unit,
      decimals: spec.decimals,
      source: spec.source,
      note: spec.note || null,
      whereLabel: spec.whereLabel || null,
      isCount: !spec.measure,
      // "Matched but filtered out" is worth showing: it explains a zero total
      // that is not the same as nothing being modelled.
      candidates: matched.length,
      present: elements.length > 0,
      nearMisses: elements.length ? [] : nearMisses(pool, spec.subtypes),
      count: elements.length,
      total,
      missingValue,
      valueSources: [...sources],
      subtotals,
      byType: [...byType.values()].sort(byValueDesc),
      byFile: [...byFile.values()].sort(byValueDesc),
      byLevel: [...byLevel.values()].sort(byValueDesc),
      elements,
    };
  });

  const missing = metrics.filter((m) => !m.present);
  const incomplete = metrics.filter((m) => m.present && m.missingValue > 0);

  return {
    metrics,
    summary: {
      total: metrics.length,
      present: metrics.length - missing.length,
      missing: missing.map((m) => m.title),
      incomplete: incomplete.map((m) => ({ title: m.title, missing: m.missingValue, of: m.count })),
    },
  };
}

/** Formats a metric total for display. */
export function formatValue(value, decimals) {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
