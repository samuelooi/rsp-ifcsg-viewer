/**
 * URA submission rules, reverse-engineered from the URA Revit Model Quality
 * Checker Plugin user guide, section 7.
 *
 * That tool checks a Revit session; this one checks the exported IFC. Most of
 * the rules are about data and survive the move unchanged. Some had to be
 * reinterpreted, and a few were dropped because nothing in an IFC can answer
 * them. Each rule below records which it is, and `reference` cites the section.
 *
 * **Deliberately not implemented**, because the evidence does not exist in an
 * exported file:
 *
 *  - *7.1, active view is a 3D view* — a property of the Revit session.
 *  - *7.1, mapping file format* — the mapping file is an input to the export.
 *    What it was supposed to achieve is visible as its result, which is what
 *    the property checks below and the IFC values check actually test.
 *  - *7.2, all URA properties defined* — its point is that the Revit template
 *    declares every parameter even when unused, but Revit omits empty
 *    parameters on export, so "declared but blank" and "never declared" are
 *    indistinguishable downstream. Dropped by decision rather than oversight.
 *  - *Wrong Revit family category* clauses — IFC records the exported entity,
 *    not the family it came from.
 *  - *Elements hidden in the active view* — view state is not exported.
 *
 * Vocabulary (7.4) is not re-checked here. Those four parameters are already
 * validated by the IFC values check against the mapping workbook, and URA's
 * additional values are merged into that list from data/ura-vocabulary.json.
 * Checking them twice would give one element two verdicts from one run.
 */

import { SEVERITY } from '../severity.js';
import { getValue, isEmptyValue, formatValue } from '../../ifcsg.js';

// ---------------------------------------------------------------- conventions

/**
 * URA's parameter prefixes map onto IFC property sets. Confirmed against the
 * generated ruleset rather than assumed: every AGF_ property in the workbook
 * sits in SGPset_SpaceArea_GFA, every ACN_ in _Connectivity, and so on.
 */
const PSET_FOR_PREFIX = {
  AGF: 'SGPset_SpaceArea_GFA',
  AVF: 'SGPset_SpaceArea_Verification',
  AST: 'SGPset_SpaceArea_Strata',
  ALS: 'SGPset_SpaceArea_Landscape',
  ACN: 'SGPset_SpaceArea_Connectivity',
};

/** Reads a URA parameter off an element, deriving its property set from the prefix. */
export function ura(el, parameter) {
  const pset = PSET_FOR_PREFIX[parameter.slice(0, 3)];
  return pset ? getValue(el, pset, parameter) : undefined;
}

const filled = (v) => !isEmptyValue(v);

/** Case- and space-insensitive comparison, as URA states its checks behave. */
const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toUpperCase();
const same = (a, b) => squash(a) === squash(b);

/**
 * IFC stores booleans as STEP enumerations which the index normalises to real
 * booleans. URA's guide writes the expected value as "Yes"; a model may carry
 * the string instead of a boolean, so both read as true.
 */
function isYes(v) {
  if (v === true) return true;
  if (v === false || v == null) return false;
  return ['TRUE', 'T', 'YES', '1'].includes(String(v).trim().toUpperCase());
}

/**
 * The Areas URA checks: Revit Area objects tagged `IfcObjectType = Area_GFA`,
 * which export as IfcSpace with that ObjectType. Areas under 1 m² are excluded,
 * per 7.7, so stray slivers do not drag the percentage thresholds down.
 */
const MIN_AREA_M2 = 1;

export function areaGfa(ctx) {
  const spaces = ctx.index.byEntity.get('IFCSPACE') || [];
  return spaces.filter((el) => {
    if (!same(el.objectType, 'Area_GFA') && !same(el.predefinedType, 'Area_GFA')) return false;
    const a = Number(getValue(el, 'SGPset_SpaceDimension', 'Area'));
    // An area that is absent is kept: its absence is a finding for other rules,
    // and excluding it here would hide it from all of them.
    return !Number.isFinite(a) || a > MIN_AREA_M2;
  });
}

/** A model-level finding, for rules about the submission rather than an element. */
const say = (severity, message, element) => ({ severity, message, element });

/**
 * Builds a "at least N% of Area_GFA objects carry this parameter" rule.
 * These are the core-properties checks in 7.3, whose thresholds are the main
 * thing that differs between the two gateways.
 */
function threshold({ id, parameter, percent, minimum, gateways, reference }) {
  return {
    id,
    title: minimum
      ? `At least ${minimum} Area_GFA object has ${parameter} filled in`
      : `At least ${percent}% of Area_GFA objects have ${parameter} filled in`,
    reference,
    gateways,
    severity: SEVERITY.FAIL,
    applies: (ctx) => areaGfa(ctx).length > 0,
    evaluate: (ctx) => {
      const areas = areaGfa(ctx);
      const have = areas.filter((el) => filled(ura(el, parameter)));
      const ratio = areas.length ? (have.length / areas.length) * 100 : 0;
      const ok = minimum ? have.length >= minimum : ratio >= percent;

      if (ok) {
        return [say(SEVERITY.PASS,
          `${have.length} of ${areas.length} Area_GFA objects (${ratio.toFixed(0)}%) carry ${parameter}.`)];
      }
      // Name the offenders rather than only the shortfall, so the finding is
      // actionable in the model instead of merely true.
      const missing = areas.filter((el) => !filled(ura(el, parameter)));
      return [
        say(SEVERITY.FAIL, minimum
          ? `No Area_GFA object carries ${parameter}; at least ${minimum} must.`
          : `Only ${have.length} of ${areas.length} Area_GFA objects (${ratio.toFixed(0)}%) ` +
            `carry ${parameter}; at least ${percent}% must.`),
        ...missing.slice(0, 100).map((el) =>
          say(SEVERITY.FAIL, `${parameter} is not filled in.`, el)),
      ];
    },
  };
}

// --------------------------------------------------------------------- rules

/** @type {import('../authority-kit.js').AuthorityRule[]} */
export const RULES = [
  // ------------------------------------------- 7.3 core properties populated
  threshold({
    id: 'ura-dg-1.2-agf-name',
    parameter: 'AGF_Name',
    minimum: 1,
    gateways: ['design'],
    reference: 'URA guide 7.3, DG 1.2',
  }),
  threshold({
    id: 'ura-dg-1.3-landscape',
    parameter: 'ALS_LandscapeType',
    minimum: 1,
    gateways: ['design'],
    reference: 'URA guide 7.3, DG 1.3',
  }),
  threshold({
    id: 'ura-cg-1.2-agf-name',
    parameter: 'AGF_Name',
    percent: 50,
    gateways: ['construction'],
    reference: 'URA guide 7.3, CG 1.2',
  }),
  threshold({
    id: 'ura-cg-1.3-development-use',
    parameter: 'AGF_DevelopmentUse',
    percent: 50,
    gateways: ['construction'],
    reference: 'URA guide 7.3, CG 1.3',
  }),
  threshold({
    id: 'ura-cg-1.4-include-as-gfa',
    parameter: 'AVF_IncludeAsGFA',
    percent: 20,
    gateways: ['construction'],
    reference: 'URA guide 7.3, CG 1.4',
  }),
  threshold({
    id: 'ura-cg-1.5-landscape',
    parameter: 'ALS_LandscapeType',
    minimum: 1,
    gateways: ['construction'],
    reference: 'URA guide 7.3, CG 1.5',
  }),

  // ------------------------------------------------ 7.5 sanity checks, 2.1
  {
    id: 'ura-2.1-area-gfa-information-filled',
    title: 'Area_GFA objects carry at least one URA parameter',
    reference: 'URA guide 7.5, DG/CG 2.1',
    gateways: ['design', 'construction'],
    severity: SEVERITY.FAIL,
    select: areaGfa,
    assert: (el) => {
      const anyFilled = Object.keys(PSET_FOR_PREFIX).some((prefix) => {
        const pset = el.psets && el.psets[PSET_FOR_PREFIX[prefix]];
        return pset && Object.values(pset).some((v) => filled(v));
      });
      return anyFilled ||
        'None of the AGF, AVF, ALS, ACN or AST parameters carry a value, so this area tells the reviewer nothing.';
    },
  },

  // ------------------------------------------ 7.5 sanity checks, CG 2.6-2.10
  {
    id: 'ura-cg-2.6-private-strata-is-gfa',
    title: 'Private strata areas are included as GFA',
    reference: 'URA guide 7.5, CG 2.6',
    gateways: ['construction'],
    severity: SEVERITY.FAIL,
    select: (ctx) => areaGfa(ctx).filter((el) =>
      squash(ura(el, 'AST_AreaType')).includes('PRIVATE')),
    assert: (el) => isYes(ura(el, 'AVF_IncludeAsGFA')) ||
      `AST_AreaType is "${formatValue(ura(el, 'AST_AreaType'))}" but AVF_IncludeAsGFA is ` +
      `${isEmptyValue(ura(el, 'AVF_IncludeAsGFA')) ? 'not set' : formatValue(ura(el, 'AVF_IncludeAsGFA'))}. ` +
      'A private strata area counts towards GFA.',
  },
  {
    id: 'ura-cg-2.7-dwelling-units-present',
    title: 'Dwelling units found in a residential (non-landed) development',
    reference: 'URA guide 7.5, CG 2.7',
    gateways: ['construction'],
    severity: SEVERITY.FAIL,
    // Only meaningful once something declares the development residential.
    applies: (ctx) => areaGfa(ctx).some((el) =>
      same(ura(el, 'AGF_DevelopmentUse'), 'Residential (Non-landed)')),
    evaluate: (ctx) => {
      const areas = areaGfa(ctx);
      const residential = areas.filter((el) =>
        same(ura(el, 'AGF_DevelopmentUse'), 'Residential (Non-landed)'));
      const dwellings = areas.filter((el) => same(ura(el, 'AGF_Name'), 'Dwelling Unit (Nett)'));
      return [dwellings.length
        ? say(SEVERITY.PASS,
          `${residential.length} residential (non-landed) areas, and ${dwellings.length} ` +
          'areas named "Dwelling Unit (Nett)" are present.')
        : say(SEVERITY.FAIL,
          `${residential.length} areas are typed Residential (Non-landed), but no area is ` +
          'named "Dwelling Unit (Nett)". A non-landed residential development must declare its ' +
          'nett dwelling units.')];
    },
  },
  {
    id: 'ura-cg-2.8-development-use-on-gfa',
    title: 'Development use is defined on every area included as GFA',
    reference: 'URA guide 7.5, CG 2.8',
    gateways: ['construction'],
    severity: SEVERITY.FAIL,
    select: (ctx) => areaGfa(ctx).filter((el) => isYes(ura(el, 'AVF_IncludeAsGFA'))),
    assert: (el) => filled(ura(el, 'AGF_DevelopmentUse')) ||
      'AVF_IncludeAsGFA is True but AGF_DevelopmentUse is empty, so the GFA cannot be attributed to a use.',
  },
  {
    id: 'ura-cg-2.9-bonus-gfa-is-gfa',
    title: 'Bonus GFA areas are included as GFA',
    reference: 'URA guide 7.5, CG 2.9',
    gateways: ['construction'],
    severity: SEVERITY.FAIL,
    select: (ctx) => areaGfa(ctx).filter((el) => filled(ura(el, 'AGF_BonusGFAType'))),
    assert: (el) => isYes(ura(el, 'AVF_IncludeAsGFA')) ||
      `AGF_BonusGFAType is "${formatValue(ura(el, 'AGF_BonusGFAType'))}" but AVF_IncludeAsGFA is ` +
      `${isEmptyValue(ura(el, 'AVF_IncludeAsGFA')) ? 'not set' : formatValue(ura(el, 'AVF_IncludeAsGFA'))}. ` +
      'Bonus GFA must be counted as GFA.',
  },
  {
    id: 'ura-cg-2.10-unit-numbers',
    title: 'Unit numbers are provided for dwelling units',
    reference: 'URA guide 7.5, CG 2.10',
    gateways: ['construction'],
    severity: SEVERITY.FAIL,
    select: (ctx) => areaGfa(ctx).filter((el) => same(ura(el, 'AGF_Name'), 'Dwelling Unit (Nett)')),
    assert: (el) => filled(ura(el, 'AGF_UnitNumber')) ||
      'AGF_Name is "Dwelling Unit (Nett)" but AGF_UnitNumber is blank.',
  },

  // --------------------------------------------- 7.7 core elements required
  {
    id: 'ura-4.1-area-gfa-present',
    title: 'The model contains Area_GFA objects',
    reference: 'URA guide 7.7, DG/CG 4.1',
    gateways: ['design', 'construction'],
    severity: SEVERITY.FAIL,
    evaluate: (ctx) => {
      const areas = areaGfa(ctx);
      return [areas.length
        ? say(SEVERITY.PASS, `${areas.length} Area_GFA objects over ${MIN_AREA_M2} m² found.`)
        : say(SEVERITY.FAIL,
          'No IfcSpace with ObjectType Area_GFA and an area over 1 m² is present. GFA cannot be reviewed.')];
    },
  },
  {
    id: 'ura-4.2-site-boundary-present',
    title: 'A site boundary is modelled',
    reference: 'URA guide 7.7, DG/CG 4.2',
    gateways: ['design', 'construction'],
    severity: SEVERITY.FAIL,
    evaluate: (ctx) => {
      const found = geographicElements(ctx, 'SITEBOUNDARY');
      return [found.length
        ? say(SEVERITY.PASS, `${found.length} IfcGeographicElement with ObjectType SITEBOUNDARY found.`)
        : say(SEVERITY.FAIL,
          'No IfcGeographicElement with ObjectType SITEBOUNDARY is present. The geo-referencing ' +
          'check cannot compare a site boundary against the cadastral lot without one.')];
    },
  },
  {
    id: 'ura-4.3-terrain-existing',
    title: 'Terrain is modelled and its status is Existing',
    reference: 'URA guide 7.7, DG/CG 4.3',
    gateways: ['design', 'construction'],
    severity: SEVERITY.FAIL,
    evaluate: (ctx) => {
      const found = geographicElements(ctx, 'TERRAIN');
      if (!found.length) {
        return [say(SEVERITY.FAIL,
          'No IfcGeographicElement with ObjectType Terrain is present.')];
      }
      const out = [];
      for (const el of found) {
        // Revit's "Status" lands in the element's own SGPset or the IFC common
        // set depending on the mapping file, so both are accepted.
        const status = getValue(el, 'SGPset_GeographicElement', 'Status') ??
          getValue(el, 'Pset_GeographicElementCommon', 'Status');
        out.push(same(status, 'Existing')
          ? say(SEVERITY.PASS, `Terrain status is "${formatValue(status)}".`, el)
          : say(SEVERITY.FAIL, isEmptyValue(status)
            ? 'Terrain element carries no Status; it must be set to Existing.'
            : `Terrain status is "${formatValue(status)}"; it must be Existing.`, el));
      }
      return out;
    },
  },

  // ------------------------------------------- 7.8 other model quality checks
  {
    id: 'ura-5.1-file-size',
    title: 'Every submitted file is within the 800 MB limit',
    reference: 'URA guide 7.8, DG/CG 5.1',
    gateways: ['design', 'construction'],
    severity: SEVERITY.FAIL,
    applies: (ctx) => Array.isArray(ctx.files) && ctx.files.some((f) => f.bytes > 0),
    evaluate: (ctx) => {
      const LIMIT = 800 * 1024 * 1024;
      const mb = (n) => (n / (1024 * 1024)).toFixed(1) + ' MB';
      const over = ctx.files.filter((f) => f.bytes > LIMIT);
      return over.length
        ? over.map((f) => say(SEVERITY.FAIL,
          `${f.name} is ${mb(f.bytes)}, over the 800 MB CORENET X limit.`))
        : [say(SEVERITY.PASS,
          `${ctx.files.length} file${ctx.files.length > 1 ? 's' : ''}, largest ` +
          `${mb(Math.max(...ctx.files.map((f) => f.bytes)))}.`)];
    },
  },
  {
    id: 'ura-5.2-level-consistency',
    title: 'Level names and elevations are consistent across files',
    reference: 'URA guide 7.8, DG/CG 5.2',
    gateways: ['design', 'construction'],
    severity: SEVERITY.FAIL,
    applies: (ctx) => (ctx.index.storeys || []).length > 0,
    evaluate: (ctx) => {
      const storeys = ctx.index.storeys || [];
      const out = [];

      // Elevations arrive normalised to millimetres whatever unit each file was
      // authored in, so they compare directly and a mixed-unit federation is
      // judged on height rather than on the numbers happening to differ.
      const show = (s) => `${s.elevation} mm`;

      // Resolved through the placement chain to one datum and rounded, so
      // exporter noise like -499.9999999999913 is not read as a disagreement.
      const byName = new Map();
      for (const s of storeys) {
        const key = squash(s.name);
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(s);
      }

      const fileOf = (s) =>
        (ctx.modelNames && ctx.modelNames.get(s.modelID)) || `model ${s.modelID}`;

      let clashes = 0;
      for (const [, group] of byName) {
        const levels = [...new Set(group.map((s) => s.elevation))];
        if (levels.length <= 1) continue;
        clashes++;

        // Duplicate level names occur within a single file as often as between
        // files, so the wording has to follow the data rather than assume a
        // federated set.
        const byElevation = new Map();
        for (const s of group) {
          if (!byElevation.has(s.elevation)) byElevation.set(s.elevation, []);
          byElevation.get(s.elevation).push(s);
        }
        const oneFile = new Set(group.map((s) => s.modelID)).size === 1;
        const where = [...byElevation.entries()]
          .sort((a, b) => a[0] - b[0])
          // Naming the file only helps when there is more than one of them.
          .map(([, members]) => oneFile
            ? show(members[0])
            : `${show(members[0])} in ${[...new Set(members.map(fileOf))].join(', ')}`)
          .join(' and ');

        out.push(say(SEVERITY.FAIL,
          `Level "${group[0].name}" is defined at ${levels.length} different elevations ` +
          `${oneFile ? `within ${fileOf(group[0])}` : 'across files'}: ${where}.`));
      }
      if (!clashes) {
        out.push(say(SEVERITY.PASS,
          `${byName.size} distinct level name${byName.size > 1 ? 's' : ''} across ` +
          `${storeys.length} storeys, with matching elevations.`));
      }

      // Levels drawn against the project base point rather than Singapore
      // Height Datum show up as an implausibly high lowest level. The guide
      // states the ceiling as 100 m; elevations are in millimetres.
      const CEILING_MM = 100 * 1000;
      const lowest = Math.min(...storeys.map((s) => s.elevation));
      out.push(lowest <= CEILING_MM
        ? say(SEVERITY.PASS, `Lowest level is at ${lowest} mm.`)
        : say(SEVERITY.FAIL,
          `Lowest level is at ${lowest} mm, above the 100 m (${CEILING_MM} mm) ceiling. ` +
          'Levels look to be set out from the project base point rather than Singapore ' +
          'Height Datum.'));
      return out;
    },
  },

  // ---------------------------------- 7.9 export settings, read from the file
  //
  // The guide checks Revit's export dialogue. That dialogue is gone by the time
  // an IFC exists, so these read the fingerprints the settings leave behind.
  {
    id: 'ura-6.2-common-property-sets',
    title: 'IFC common property sets were exported',
    reference: 'URA guide 7.9, DG/CG 6.2 (inferred from the file)',
    gateways: ['design', 'construction'],
    severity: SEVERITY.WARN,
    evaluate: (ctx) => {
      const n = countElementsWithPsetMatching(ctx, /^Pset_.*Common$/i);
      return [n
        ? say(SEVERITY.PASS, `${n} elements carry an IFC common property set.`)
        : say(SEVERITY.WARN,
          'No element carries a Pset_…Common property set. "Export IFC common property sets" ' +
          'looks to have been off, and the reviewer loses the standard IFC properties.')];
    },
  },
  {
    id: 'ura-6.2-base-quantities',
    title: 'Base quantities were exported',
    reference: 'URA guide 7.9, DG/CG 6.2 (inferred from the file)',
    gateways: ['design', 'construction'],
    severity: SEVERITY.WARN,
    evaluate: (ctx) => {
      const n = countElementsWithPsetMatching(ctx, /^(Qto_|BaseQuantities)/i);
      return [n
        ? say(SEVERITY.PASS, `${n} elements carry base quantities.`)
        : say(SEVERITY.WARN,
          'No element carries a Qto_ quantity set. "Export base quantities" looks to have been ' +
          'off; areas and volumes are useful in review and the dashboard falls back without them.')];
    },
  },
  {
    id: 'ura-6.2-single-site',
    title: 'The model exports to a single IfcSite',
    reference: 'URA guide 7.9, DG/CG 6.2 (inferred from the file)',
    gateways: ['design', 'construction'],
    severity: SEVERITY.WARN,
    evaluate: (ctx) => {
      const sites = ctx.index.byEntity.get('IFCSITE') || [];
      if (sites.length <= 1) {
        return [say(SEVERITY.PASS, `${sites.length} IfcSite in the federated model.`)];
      }
      const names = sites.map((s) => s.name || '(unnamed)').join(', ');
      return [say(SEVERITY.WARN,
        `${sites.length} IfcSite entities are present: ${names}. BCA advises exporting to the ` +
        'same IfcSite so the model structure reads cleanly; several usually means elements were ' +
        'mapped to IfcSite by mistake.')];
    },
  },
];

// -------------------------------------------------------------------- helpers

/** IfcGeographicElement carrying a given ObjectType, per URA's identification rule. */
function geographicElements(ctx, objectType) {
  const pool = ctx.index.byEntity.get('IFCGEOGRAPHICELEMENT') || [];
  return pool.filter((el) =>
    squash(el.objectType) === squash(objectType) ||
    squash(el.predefinedType) === squash(objectType));
}

/** How many indexed elements carry a property set whose name matches. */
function countElementsWithPsetMatching(ctx, pattern) {
  let n = 0;
  for (const el of ctx.index.all) {
    if (Object.keys(el.psets || {}).some((name) => pattern.test(name))) n++;
  }
  return n;
}
