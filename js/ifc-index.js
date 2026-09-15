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

  // An element's "level" must be a storey. Containment can point at any spatial
  // element though — a bin sitting in a room is contained by the IfcSpace, not
  // the storey — so build the spatial hierarchy first and walk up from whatever
  // the relationship names until a storey is reached.
  const storeyNames = new Map();   // expressID -> storey name
  const parentOf = new Map();      // spatial expressID -> containing expressID

  try {
    const ids = api.GetLineIDsWithType(modelID, WebIFC.IFCBUILDINGSTOREY);
    for (let i = 0; i < ids.size(); i++) {
      const id = ids.get(i);
      try {
        storeyNames.set(id, unwrap(api.GetLine(modelID, id, false).Name));
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
      for (const h of rel.RelatedObjects) {
        if (h) parentOf.set(h.value, rel.RelatingObject.value);
      }
    }
  } catch { /* no aggregation */ }

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

  for (const idx of indexes) {
    for (const el of idx.all) {
      byId.set(el.key, el);
      all.push(el);
      if (!byEntity.has(el.canonicalEntity)) byEntity.set(el.canonicalEntity, []);
      byEntity.get(el.canonicalEntity).push(el);
    }
  }

  return { byId, byEntity, all, count: all.length };
}
