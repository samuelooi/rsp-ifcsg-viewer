/**
 * Builds a queryable index of the loaded IFC model.
 *
 * web-ifc exposes properties one line at a time, which is far too slow to query
 * per element on demand. Instead this walks the relationship tables once at load
 * and materialises, for every element the ruleset cares about: its entity,
 * PredefinedType/ObjectType, identity, containing storey, and every property set
 * attached to it.
 */

import * as WebIFC from 'web-ifc';
import { ENTITY_ALIASES } from './ifcsg.js';

/** expressID type-code -> "IFCWALL", built once from the web-ifc schema exports. */
const TYPE_NAMES = (() => {
  const map = new Map();
  for (const [key, val] of Object.entries(WebIFC)) {
    if (typeof val === 'number' && /^IFC[A-Z0-9]+$/.test(key)) map.set(val, key);
  }
  return map;
})();

/** "IFCWALL" -> "IfcWall", for display. */
function prettyEntity(upper) {
  if (!upper) return '';
  return 'Ifc' + upper.slice(3).charAt(0) + upper.slice(4).toLowerCase();
}

/**
 * Unwraps a web-ifc value handle to a primitive.
 * Values arrive as `{ value, type, label }`, sometimes nested or in arrays.
 */
function unwrap(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    const parts = v.map(unwrap).filter((x) => x !== null && x !== '');
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof v === 'object') return 'value' in v ? unwrap(v.value) : null;
  return v;
}

/**
 * IFC encodes booleans as STEP enumerations (`.T.` / `.F.`), which web-ifc
 * surfaces as the bare strings "T" / "F" under an IFCBOOLEAN or IFCLOGICAL
 * label. Normalise those to real JS booleans here, once, so that comparison,
 * grouping and display downstream all agree on what the value is.
 *
 * IfcLogical has a third state, UNKNOWN, which is not a boolean and is kept as
 * a distinct label rather than being collapsed into false.
 */
function normaliseBoolean(value, label) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;
  if (label !== 'IFCBOOLEAN' && label !== 'IFCLOGICAL') return value;

  switch (value.trim().toUpperCase()) {
    case 'T': case 'TRUE': return true;
    case 'F': case 'FALSE': return false;
    case 'U': case 'UNKNOWN': return 'Unknown';
    default: return value;
  }
}

/** Unwraps a value handle and applies IFC type-aware normalisation. */
function unwrapTyped(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v) {
    return normaliseBoolean(unwrap(v), v.label);
  }
  return unwrap(v);
}

/** Quantity lines carry their magnitude on a type-specific field. */
const QUANTITY_FIELDS = [
  'LengthValue', 'AreaValue', 'VolumeValue', 'CountValue',
  'WeightValue', 'TimeValue', 'PerimeterValue',
];

/** Reads one property line (single value, enumerated, list, bounded, or quantity). */
function readProperty(p) {
  if (!p || !p.Name) return null;
  const name = unwrap(p.Name);
  if (!name) return null;

  let value = null;
  if (p.NominalValue !== undefined) value = unwrapTyped(p.NominalValue);
  else if (p.EnumerationValues !== undefined) value = unwrap(p.EnumerationValues);
  else if (p.ListValues !== undefined) value = unwrap(p.ListValues);
  else if (p.SetPointValue !== undefined) value = unwrapTyped(p.SetPointValue);
  else {
    for (const field of QUANTITY_FIELDS) {
      if (p[field] !== undefined) { value = unwrap(p[field]); break; }
    }
  }
  return { name, value };
}

/** SI prefix -> multiplier, for resolving the project's length unit. */
const SI_PREFIX = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3,
  HECTO: 1e2, DECA: 1e1, DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3,
  MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};


/**
 * Captures how the model is tied to the real world.
 *
 * This has to happen while the parsed IFC is still open. The viewer releases it
 * as soon as indexing finishes, and nothing afterwards can read a line again —
 * so georeferencing, like everything else the app needs, is read once here.
 *
 * Three sources, in descending order of trustworthiness:
 *
 *  - **IfcMapConversion + IfcProjectedCRS** — the only one that actually defines
 *    a transform: an offset, a rotation and a scale onto a named CRS.
 *  - **IfcSite RefLatitude / RefLongitude** — a single point with no rotation.
 *    Useful to cross-check the above, not to replace it.
 *  - **Nothing** — the model is not georeferenced.
 */
export function readGeoreference(api, modelID) {
  const first = (type) => {
    try {
      const ids = api.GetLineIDsWithType(modelID, type);
      return ids.size() ? api.GetLine(modelID, ids.get(0), false) : null;
    } catch {
      return null;
    }
  };

  const num = (v) => {
    const raw = v && typeof v === 'object' && 'value' in v ? v.value : v;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };

  // ---- project length unit, so the map conversion's scale can be interpreted
  let metresPerUnit = 1;
  let lengthUnitName = 'METRE';
  try {
    const ids = api.GetLineIDsWithType(modelID, WebIFC.IFCPROJECT);
    if (ids.size()) {
      const project = api.GetLine(modelID, ids.get(0), true);
      const units = project && project.UnitsInContext && project.UnitsInContext.Units;
      for (const u of units || []) {
        const type = unwrap(u && u.UnitType);
        const name = unwrap(u && u.Name);
        if (type !== 'LENGTHUNIT' || !name) continue;
        const prefix = unwrap(u.Prefix);
        metresPerUnit = prefix && SI_PREFIX[prefix] ? SI_PREFIX[prefix] : 1;
        lengthUnitName = (prefix ? prefix + ' ' : '') + name;
        break;
      }
    }
  } catch { /* unusual unit assignment; metres is the safe assumption */ }

  // ---- map conversion
  const mc = first(WebIFC.IFCMAPCONVERSION);
  let mapConversion = null;
  if (mc) {
    const abscissa = num(mc.XAxisAbscissa);
    const ordinate = num(mc.XAxisOrdinate);
    mapConversion = {
      eastings: num(mc.Eastings) || 0,
      northings: num(mc.Northings) || 0,
      orthogonalHeight: num(mc.OrthogonalHeight) || 0,
      // The rotation is given as a direction rather than an angle. A missing
      // pair means "no rotation", which is not the same as pointing at zero.
      rotation: abscissa === null && ordinate === null
        ? 0 : Math.atan2(ordinate || 0, abscissa === null ? 1 : abscissa),
      scale: num(mc.Scale) === null ? 1 : num(mc.Scale),
    };
  }

  // ---- projected CRS
  const crsLine = first(WebIFC.IFCPROJECTEDCRS);
  const crs = crsLine ? {
    name: unwrap(crsLine.Name),
    description: unwrap(crsLine.Description),
    geodeticDatum: unwrap(crsLine.GeodeticDatum),
    mapProjection: unwrap(crsLine.MapProjection),
    mapZone: unwrap(crsLine.MapZone),
  } : null;

  // ---- site reference position: the first site that actually declares one
  let site = null;
  try {
    const ids = api.GetLineIDsWithType(modelID, WebIFC.IFCSITE);
    for (let i = 0; i < ids.size(); i++) {
      const line = api.GetLine(modelID, ids.get(i), false);
      if (!line || (!line.RefLatitude && !line.RefLongitude)) continue;
      site = {
        name: unwrap(line.Name),
        refLatitude: line.RefLatitude,
        refLongitude: line.RefLongitude,
        refElevation: num(line.RefElevation),
      };
      break;
    }
  } catch { /* no sites */ }

  return { mapConversion, crs, site, metresPerUnit, lengthUnitName };
}

/**
 * @param {WebIFC.IfcAPI} api
 * @param {number} modelID        the web-ifc model handle
 * @param {object} ruleset        from ifcsg.js — supplies which entities matter
 * @param {(msg: string, pct: number) => void} [onProgress]
 */
export function buildIndex(api, modelID, ruleset, onProgress = () => {}) {
  // ---------------------------------------------------- which types to collect
  // Canonical entities from the ruleset, plus the standard-case variants that
  // fold onto them.
  const wanted = new Map(); // type code -> canonical entity name
  for (const canon of ruleset.entities) {
    const code = WebIFC[canon];
    if (typeof code === 'number') wanted.set(code, canon);
  }
  for (const [alias, base] of ENTITY_ALIASES) {
    if (!ruleset.entities.has(base)) continue;
    const code = WebIFC[alias];
    if (typeof code === 'number') wanted.set(code, base);
  }

  // ------------------------------------------------------------- elements pass
  onProgress('Indexing elements…', 10);

  const byId = new Map();
  const byEntity = new Map();

  for (const [code, canon] of wanted) {
    let ids;
    try {
      ids = api.GetLineIDsWithType(modelID, code);
    } catch {
      continue; // type absent from this schema
    }
    const n = ids.size();
    for (let i = 0; i < n; i++) {
      const id = ids.get(i);
      let line;
      try {
        line = api.GetLine(modelID, id, false);
      } catch {
        continue;
      }
      const actual = TYPE_NAMES.get(line.type) || canon;
      const el = {
        expressID: id,
        modelID,
        // expressIDs are only unique within one model, so anything that spans
        // models (selection, hiding, the merged index) keys on this instead.
        key: `${modelID}:${id}`,
        entity: ruleset.entityDisplay.get(actual) || prettyEntity(actual),
        rawEntity: actual,
        canonicalEntity: canon,
        globalId: unwrap(line.GlobalId),
        name: unwrap(line.Name),
        description: unwrap(line.Description),
        objectType: unwrap(line.ObjectType),
        predefinedType: unwrap(line.PredefinedType),
        tag: unwrap(line.Tag),
        storey: null,
        psets: {},
        // Whether the element draws anything itself. Revit exports a stair,
        // roof or curtain wall as a container with no Representation; all the
        // triangles belong to the parts it aggregates (see `parts` below).
        hasGeometry: !!(line.Representation && line.Representation.value !== undefined),
        /** expressIDs of the aggregated descendants that carry this element's geometry. */
        parts: [],
        /** `key` of the geometry-less aggregate this element is a part of, if any. */
        hostKey: null,
      };
      byId.set(id, el);
      if (!byEntity.has(canon)) byEntity.set(canon, []);
      byEntity.get(canon).push(el);
    }
  }

  // ----------------------------------------------------------- properties pass
  onProgress('Reading property sets…', 45);

  const psetCache = new Map();

  /** Reads and caches a property-set / quantity-set definition line. */
  function readDefinition(defID) {
    if (psetCache.has(defID)) return psetCache.get(defID);
    let def = null;
    try {
      const line = api.GetLine(modelID, defID, true);
      const name = unwrap(line.Name);
      const entries = line.HasProperties || line.Quantities;
      if (name && Array.isArray(entries)) {
        const props = {};
        for (const p of entries) {
          const read = readProperty(p);
          if (read) props[read.name] = read.value;
        }
        def = { name, props };
      }
    } catch {
      def = null;
    }
    psetCache.set(defID, def);
    return def;
  }

  try {
    const rels = api.GetLineIDsWithType(modelID, WebIFC.IFCRELDEFINESBYPROPERTIES);
    const n = rels.size();
    for (let i = 0; i < n; i++) {
      let rel;
      try {
        rel = api.GetLine(modelID, rels.get(i), false);
      } catch {
        continue;
      }
      const related = rel.RelatedObjects;
      const defHandle = rel.RelatingPropertyDefinition;
      if (!Array.isArray(related) || !defHandle) continue;

      // Skip the definition read entirely unless it touches an indexed element.
      const hits = related.filter((h) => h && byId.has(h.value));
      if (!hits.length) continue;

      const def = readDefinition(defHandle.value);
      if (!def) continue;

      for (const h of hits) {
        const el = byId.get(h.value);
        // Merge rather than replace: a model may attach several sets of the
        // same name, and later definitions should not drop earlier properties.
        el.psets[def.name] = Object.assign(el.psets[def.name] || {}, def.props);
      }
    }
  } catch {
    /* model has no property relationships */
  }

  // ------------------------------------------------------- spatial structure
  onProgress('Resolving spatial structure…', 80);

  const georef = readGeoreference(api, modelID);

  /**
   * Absolute height of a placement, by walking the chain to the project origin.
   *
   * A storey's `Elevation` attribute is relative to whatever spatial element
   * contains it, so two files can quote the same number for different heights.
   * Accumulating the placement chain gives one datum every file can be compared
   * against — which is what checking level consistency across a federated set
   * requires. Only the Z translation is accumulated; storeys are not tilted, and
   * a rotation about Z does not change height.
   */
  function placementHeight(placementID) {
    let z = 0;
    let current = placementID;
    for (let hops = 0; current != null && hops < 32; hops++) {
      let line;
      try {
        line = api.GetLine(modelID, current, false);
      } catch {
        break;
      }
      if (!line) break;
      const rel = line.RelativePlacement;
      if (rel && rel.value !== undefined) {
        try {
          const axis = api.GetLine(modelID, rel.value, false);
          const loc = axis && axis.Location;
          if (loc && loc.value !== undefined) {
            const point = api.GetLine(modelID, loc.value, false);
            const coords = point && point.Coordinates;
            if (Array.isArray(coords) && coords.length >= 3) {
              const v = unwrap(coords[2]);
              if (Number.isFinite(Number(v))) z += Number(v);
            }
          }
        } catch { /* malformed placement; treat this link as zero */ }
      }
      current = line.PlacementRelTo && line.PlacementRelTo.value !== undefined
        ? line.PlacementRelTo.value : null;
    }
    return z;
  }

  // An element's "level" must be a storey. Containment can point at any spatial
  // element though — a bin sitting in a room is contained by the IfcSpace, not
  // the storey — so build the spatial hierarchy first and walk up from whatever
  // the relationship names until a storey is reached.
  const storeyNames = new Map();   // expressID -> storey name
  const parentOf = new Map();      // aggregated expressID -> its RelatingObject
  const childrenOf = new Map();    // RelatingObject expressID -> aggregated expressIDs
  const storeys = [];              // [{ expressID, name, elevation, declared, unit, … }]

  /**
   * Lengths are reported in millimetres, whatever unit the file was authored in.
   *
   * Two reasons. A federated set can mix units, and normalising here means
   * everything downstream compares like with like without carrying a unit
   * around. And millimetres are what the modeller drew in: a level set out at
   * -500 should read as -500, not as -0.5.
   *
   * The rounding matters as much as the unit. Exporters emit -499.9999999999913
   * for what was drawn as -500, and that noise would otherwise read as a genuine
   * disagreement between two levels.
   */
  const metresPerUnit = georef.metresPerUnit || 1;
  const toMm = (n) => (Number.isFinite(n)
    ? Math.round(n * metresPerUnit * 1000 * 1000) / 1000
    : null);

  try {
    const ids = api.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY);
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      try {
        const line = api.GetLine(modelID, id, false);
        const name = unwrap(line.Name);
        storeyNames.set(id, name);

        const declared = Number(unwrap(line.Elevation));
        const placement = line.ObjectPlacement && line.ObjectPlacement.value !== undefined
          ? placementHeight(line.ObjectPlacement.value) : null;

        // Absolute, from the placement chain; the declared attribute is the
        // fallback and is kept so a disagreement between them is visible.
        const absolute = placement !== null ? placement
          : (Number.isFinite(declared) ? declared : 0);

        storeys.push({
          modelID,
          expressID: id,
          name,
          // Millimetres, normalised from whatever the file was authored in.
          elevation: toMm(absolute),
          declared: Number.isFinite(declared) ? toMm(declared) : null,
          unit: 'mm',
          resolved: placement !== null,
        });
      } catch { /* unreadable storey */ }
    }
  } catch { /* no storeys */ }

  try {
    const rels = api.GetLineIDsWithType(modelID, WebIFC.IFCRELAGGREGATES);
    for (let i = 0; i < rels.size(); i++) {
      let rel;
      try {
        rel = api.GetLine(modelID, rels.get(i), false);
      } catch {
        continue;
      }
      if (!Array.isArray(rel.RelatedObjects) || !rel.RelatingObject) continue;
      const parent = rel.RelatingObject.value;
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      for (const h of rel.RelatedObjects) {
        if (!h) continue;
        parentOf.set(h.value, parent);
        childrenOf.get(parent).push(h.value);
      }
    }
  } catch { /* no aggregation */ }

  // ------------------------------------------------------- aggregate geometry
  // A geometry-less aggregate (a Revit stair: flights, landings, stringers and
  // railings under one IfcStair) has to be coloured, hidden and measured
  // through its parts, since a subset of its own expressID draws nothing.
  // Spatial elements aggregate too (site -> building -> storey -> spaces) but
  // are never expanded: colouring a building must not paint its rooms.
  const SPATIAL = new Set(['IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE']);

  /** Every aggregated descendant, depth first, stopping at spatial elements. */
  function descendants(id, out, seen) {
    for (const child of childrenOf.get(id) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      const el = byId.get(child);
      if (el && SPATIAL.has(el.canonicalEntity)) continue;
      out.push(child);
      descendants(child, out, seen);
    }
  }

  // Nearest geometry-less host above a part. A host nested inside another host
  // is the nearer one, so it is assigned last and wins.
  const hostOf = new Map(); // part expressID -> host expressID
  const hosts = [...byId.values()].filter((el) =>
    !el.hasGeometry && !SPATIAL.has(el.canonicalEntity) && childrenOf.has(el.expressID));
  const depth = (id) => {
    let d = 0;
    for (let cur = parentOf.get(id); cur != null && d < 32; cur = parentOf.get(cur)) d++;
    return d;
  };
  hosts.sort((a, b) => depth(a.expressID) - depth(b.expressID));
  for (const host of hosts) {
    descendants(host.expressID, host.parts, new Set([host.expressID]));
    for (const part of host.parts) hostOf.set(part, host.expressID);
  }
  for (const [part, host] of hostOf) {
    const el = byId.get(part);
    if (el) el.hostKey = `${modelID}:${host}`;
  }

  /** Nearest enclosing storey name, or null if the chain never reaches one. */
  function storeyFor(id) {
    let cur = id;
    for (let hops = 0; cur != null && hops < 32; hops++) {
      if (storeyNames.has(cur)) return storeyNames.get(cur);
      cur = parentOf.get(cur);
    }
    return null;
  }

  // Elements contained in a spatial element (the usual case for building parts).
  try {
    const rels = api.GetLineIDsWithType(modelID, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
    for (let i = 0; i < rels.size(); i++) {
      let rel;
      try {
        rel = api.GetLine(modelID, rels.get(i), false);
      } catch {
        continue;
      }
      if (!Array.isArray(rel.RelatedElements) || !rel.RelatingStructure) continue;
      const storey = storeyFor(rel.RelatingStructure.value);
      if (!storey) continue;
      for (const h of rel.RelatedElements) {
        const el = h && byId.get(h.value);
        if (el) el.storey = storey;
      }
    }
  } catch { /* no spatial containment */ }

  // Spaces are decomposed from their storey rather than contained in it, so they
  // are reached through the aggregation hierarchy instead.
  for (const el of byId.values()) {
    if (!el.storey) el.storey = storeyFor(el.expressID);
  }

  onProgress('Index ready', 100);

  const all = [...byId.values()];
  return {
    modelID,
    byId: new Map(all.map((e) => [e.key, e])),
    byExpressID: byId,
    byEntity,
    all,
    count: all.length,
    georef,
    storeys,
    // `key` of a part -> `key` of its geometry-less host. Parts that are not
    // themselves indexed (a stair's IfcMember stringers) are only reachable
    // through this, so a click on one can still resolve to the stair.
    hostOf: new Map([...hostOf].map(([part, host]) => [`${modelID}:${part}`, `${modelID}:${host}`])),
  };
}

/**
 * Combines per-model indexes into the single index the queries and checks run
 * against, so a federated set of files behaves like one model.
 */
export function mergeIndexes(indexes) {
  const byId = new Map();
  const byEntity = new Map();
  const all = [];

  // The first model loaded establishes the datum every later model is placed
  // against, so its georeferencing is the one that describes the scene. Keep
  // the others so a check can report a file that disagrees with the datum.
  const georef = indexes.length ? indexes[0].georef : null;
  const georefByModel = new Map(indexes.map((idx) => [idx.modelID, idx.georef]));
  const storeys = indexes.flatMap((idx) => idx.storeys || []);
  const hostOf = new Map();

  for (const idx of indexes) {
    for (const el of idx.all) {
      byId.set(el.key, el);
      all.push(el);
      if (!byEntity.has(el.canonicalEntity)) byEntity.set(el.canonicalEntity, []);
      byEntity.get(el.canonicalEntity).push(el);
    }
    for (const [part, host] of idx.hostOf || []) hostOf.set(part, host);
  }

  return { byId, byEntity, all, count: all.length, georef, georefByModel, storeys, hostOf };
}
