/**
 * Which model is this, really?
 *
 * A project file records what was checked, so the next session has to decide
 * whether the file now on disk is the same model as the one in the record. The
 * file name cannot answer that: submission files are renamed constantly (the
 * ADM1 test file is `…-BLDG-55.ifc` on disk while its own header still says
 * `…-BLDG-01.ifc`), and a re-export keeps the name while changing everything
 * inside.
 *
 * So identity is taken from the model's own content:
 *
 *  - **An element sketch** — the identity proper. Revit derives IFC GlobalIds
 *    from element UniqueIds, so the same model re-exported keeps nearly all of
 *    them while a different model shares almost none. Storing every GUID would
 *    be enormous, so the sketch keeps the 256 smallest hashes, which estimates
 *    how much two models overlap to within a few per cent for about 2 KB.
 *    Measured on the sample set: two different blocks of one project overlap
 *    by 0.0003, two different buildings by 0.0002, a file with itself by 1.
 *  - **Spatial GUIDs** — site, building and storey GlobalIds. Used as
 *    corroboration and as the fallback when a sketch is missing. On their own
 *    they are not enough: blocks exported from one Revit model share the site,
 *    the building shell and often several levels.
 *  - **IfcProject GUID** and **Revit ContentGUID** — shared by every file of a
 *    project (verified on the sample set), so they say "belongs to this
 *    submission", never "is this file". Recorded, never matched on.
 *  - **VersionGUID, NumberOfSaves, export timestamp, byte size, element count**
 *    — these move on every save, so they say whether a matched model has been
 *    re-issued since it was recorded.
 */

/** How confident a match is. */
export const MATCH = {
  SAME: 'same',        // the same model, beyond reasonable doubt
  LIKELY: 'likely',    // probably the same model; worth confirming
  NONE: 'none',
};

/** Hashes kept per model. 256 estimates overlap closely enough for ~2 KB. */
export const SKETCH_SIZE = 256;

// Thresholds for the element sketch. A revision that replaced a third of the
// model still scores far above the 0.0003 two different models manage.
const SKETCH_SAME_AT = 0.35;
const SKETCH_LIKELY_AT = 0.12;

// Thresholds for the spatial fallback, which is much coarser.
const SPATIAL_SAME_AT = 0.7;
const SPATIAL_LIKELY_AT = 0.45;

/** FNV-1a, 32-bit. Cheap, and only needs to spread GUIDs evenly. */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The bottom-k sketch of a set of GlobalIds: the k smallest hashes, ascending.
 * @param {Iterable<string>} guids
 */
export function buildSketch(guids, k = SKETCH_SIZE) {
  const seen = new Set();
  for (const g of guids) {
    if (g) seen.add(hash32(g));
  }
  return [...seen].sort((a, b) => a - b).slice(0, k);
}

/**
 * Estimated Jaccard similarity of the two underlying sets, from their bottom-k
 * sketches: take the k smallest hashes of the union and count how many are in
 * both sketches.
 * @returns {number|null} null when either sketch is too small to say anything
 */
export function sketchSimilarity(a, b) {
  if (!a || !b || a.length < 16 || b.length < 16) return null;
  const k = Math.min(a.length, b.length);
  const setA = new Set(a);
  const setB = new Set(b);
  const union = [...new Set([...a, ...b])].sort((x, y) => x - y).slice(0, k);
  let both = 0;
  for (const h of union) if (setA.has(h) && setB.has(h)) both++;
  return both / k;
}

/**
 * Reads the STEP header without parsing the file. 64 KB is far more than any
 * header needs and costs one disk read.
 * @returns {Promise<object>} the fields worth keeping, all optional
 */
export async function readHeader(file) {
  let text = '';
  try {
    text = new TextDecoder().decode(new Uint8Array(await file.slice(0, 65536).arrayBuffer()));
  } catch {
    return {};
  }
  const end = text.indexOf('DATA;');
  const head = end > 0 ? text.slice(0, end) : text;

  const name = /FILE_NAME\s*\(\s*'((?:[^']|'')*)'\s*,\s*'((?:[^']|'')*)'/.exec(head);
  const schema = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(head);
  const content = /ContentGUID:\s*([0-9A-Fa-f-]{8,})/.exec(head);
  const version = /VersionGUID:\s*([0-9A-Fa-f-]{8,})/.exec(head);
  const saves = /NumberOfSaves:\s*(\d+)/.exec(head);
  // The last two FILE_NAME strings are the originating system and the preprocessor.
  const tool = /FILE_NAME\s*\([^)]*?'([^']*)'\s*,\s*'([^']*)'\s*\)\s*;/.exec(head);

  return {
    headerName: name ? name[1].replace(/''/g, "'") : null,
    exportedAt: name ? name[2] : null,
    schema: schema ? schema[1] : null,
    contentGuid: content ? content[1].toLowerCase() : null,
    versionGuid: version ? version[1].toLowerCase() : null,
    saves: saves ? Number(saves[1]) : null,
    authoringTool: tool ? (tool[2] || tool[1]) : null,
  };
}

/**
 * The identity of one loaded model: its header fields, its spatial GUIDs and
 * the coarse content counts that make a mismatch obvious to a human.
 * @param {object} header    from readHeader
 * @param {object} index     that model's index (not the merged one)
 * @param {{name: string, bytes: number}} fileInfo
 */
export function buildIdentity(header, index, fileInfo) {
  const spatial = index && index.spatial ? index.spatial : { project: null, sites: [], buildings: [] };
  const storeys = (index && index.storeys ? index.storeys : [])
    .map((s) => s.globalId).filter(Boolean);

  return {
    // The identity proper: what this model is made of. The spatial ids go in
    // too, so a small model with few mapped elements still has something to
    // be recognised by.
    sketch: buildSketch([
      ...(index && index.all ? index.all : []).map((e) => e.globalId),
      spatial.project, ...spatial.sites, ...spatial.buildings, ...storeys,
    ]),
    projectGuid: spatial.project || null,
    siteGuids: [...spatial.sites].sort(),
    buildingGuids: [...spatial.buildings].sort(),
    storeyGuids: storeys.slice().sort(),
    contentGuid: header.contentGuid || null,
    versionGuid: header.versionGuid || null,
    saves: header.saves == null ? null : header.saves,
    headerName: header.headerName || null,
    exportedAt: header.exportedAt || null,
    authoringTool: header.authoringTool || null,
    schema: header.schema || null,
    bytes: fileInfo.bytes || 0,
    elements: index ? index.count : 0,
    storeyCount: storeys.length,
  };
}

/** Every GUID that stands for "a place in this model". */
function spatialSet(identity) {
  return new Set([
    ...(identity.siteGuids || []),
    ...(identity.buildingGuids || []),
    ...(identity.storeyGuids || []),
  ]);
}

/** Intersection over union of two GUID sets; 0 when either is empty. */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * How alike two identities are.
 * @returns {{score: number, confidence: string, reasons: string[]}}
 */
export function compareIdentity(a, b) {
  if (!a || !b) return { score: 0, confidence: MATCH.NONE, reasons: [] };
  const reasons = [];

  const sketch = sketchSimilarity(a.sketch, b.sketch);
  const spatial = overlap(spatialSet(a), spatialSet(b));
  const sameHeaderName = !!(a.headerName && b.headerName && a.headerName === b.headerName);

  let score;
  let confidence = MATCH.NONE;
  if (sketch !== null) {
    score = sketch;
    reasons.push(`${Math.round(sketch * 100)}% of the elements are the same`);
    if (sketch >= SKETCH_SAME_AT) confidence = MATCH.SAME;
    else if (sketch >= SKETCH_LIKELY_AT) confidence = MATCH.LIKELY;
  } else {
    // An older record, or a model with no GlobalIds indexed. Sites, buildings
    // and storeys are coarser: files of one project share the shells, so the
    // bar is higher and a bare match is only ever "likely".
    score = spatial;
    if (spatial > 0) reasons.push(`${Math.round(spatial * 100)}% of the sites, buildings and storeys are the same`);
    if (spatial >= SPATIAL_SAME_AT && sameHeaderName) confidence = MATCH.SAME;
    else if (spatial >= SPATIAL_LIKELY_AT) confidence = MATCH.LIKELY;
  }

  if (sameHeaderName) reasons.push(`both were exported as "${a.headerName}"`);
  if (a.projectGuid && a.projectGuid === b.projectGuid) reasons.push('same IfcProject');

  return { score, confidence, reasons, sketch, spatial };
}

/**
 * Has a matched model been re-issued since the record was made?
 * @returns {{changed: boolean, reasons: string[]}}
 */
export function compareRevision(recorded, current) {
  const reasons = [];
  if (!recorded || !current) return { changed: false, reasons };

  if (recorded.versionGuid && current.versionGuid && recorded.versionGuid !== current.versionGuid) {
    reasons.push('the model was saved again in the authoring tool');
  }
  if (recorded.saves != null && current.saves != null && current.saves !== recorded.saves) {
    reasons.push(`save number ${recorded.saves} → ${current.saves}`);
  }
  if (recorded.exportedAt && current.exportedAt && recorded.exportedAt !== current.exportedAt) {
    reasons.push(`exported ${recorded.exportedAt} → ${current.exportedAt}`);
  }
  if (recorded.bytes && current.bytes && recorded.bytes !== current.bytes) {
    reasons.push(`file size ${recorded.bytes} → ${current.bytes} bytes`);
  }
  if (recorded.elements && current.elements && recorded.elements !== current.elements) {
    reasons.push(`${recorded.elements} → ${current.elements} indexed elements`);
  }
  return { changed: reasons.length > 0, reasons };
}

/**
 * The record that best matches an identity.
 * @param {object} identity
 * @param {Array<{identity: object}>} records
 * @returns {{record: object|null, score: number, confidence: string, reasons: string[]}}
 */
export function bestMatch(identity, records) {
  let best = { record: null, score: 0, confidence: MATCH.NONE, reasons: [] };
  for (const record of records || []) {
    const cmp = compareIdentity(identity, record.identity);
    if (cmp.confidence === MATCH.NONE || cmp.score <= best.score) continue;
    best = { record, ...cmp };
  }
  return best;
}

/** A short human description of a model's identity, for a tooltip. */
export function describeIdentity(identity) {
  if (!identity) return '';
  const lines = [];
  if (identity.headerName) lines.push(`Exported as ${identity.headerName}`);
  if (identity.exportedAt) lines.push(`Exported ${identity.exportedAt}`);
  if (identity.authoringTool) lines.push(identity.authoringTool);
  if (identity.schema) lines.push(`Schema ${identity.schema}`);
  if (identity.saves != null) lines.push(`Save number ${identity.saves}`);
  const n = spatialSet(identity).size;
  if (n) lines.push(`${n} site/building/storey identifiers`);
  if (identity.elements) lines.push(`${identity.elements} indexed elements`);
  if (identity.sketch && identity.sketch.length) {
    lines.push(`identified by a ${identity.sketch.length}-hash element sketch`);
  }
  return lines.join('\n');
}
