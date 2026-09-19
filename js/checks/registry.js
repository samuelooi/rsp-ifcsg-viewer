/**
 * What checks exist, and how to load them.
 *
 * The manifest below is static and always in memory. The menu, the model
 * indexer's entity union and the saved selection all read it without loading a
 * single line of check code. Only the implementation is lazy: a module is
 * fetched the first time its check is actually run, so a session that never
 * touches the URA check never downloads it.
 *
 * That split is the whole point. If metadata lived inside the modules, showing
 * the menu would mean downloading every check, and indexing would have to guess
 * which IFC entities might be needed later.
 *
 * Adding a check: create js/checks/<id>/index.js exporting the CheckModule
 * contract in ./types.js, then add one entry here. Nothing else in the app
 * needs to know it exists.
 */

/** @type {import('./types.js').CheckManifestEntry[]} */
const MANIFEST = [
  {
    id: 'ifc-values',
    title: 'IFC values',
    authority: 'IFC-SG',
    summary:
      'Every mapped element carries the property sets, properties and accepted values ' +
      'the CORENET X mapping requires. Checks the data, not the building.',
    requires: { ruleset: true },
    inputs: [
      {
        id: 'presets',
        kind: 'custom',
        label: 'Value presets',
        help: 'Your own property queries, shared with the team through ' +
          'data/value-presets.json. Ticked presets run with this check; "3D" shows ' +
          'what a preset selects. Numbers are in the units the model was authored in.',
        load: () => import('./ifc-values/preset-editor.js'),
      },
    ],
    load: () => import('./ifc-values/index.js'),
  },
  {
    id: 'geo-referencing',
    title: 'Geo-referencing',
    authority: 'URA',
    summary:
      'Is the model in the right place on the ground? Compares its survey ' +
      'coordinates against the cadastral lot the development sits on.',
    requires: { entities: ['IFCGEOGRAPHICELEMENT', 'IFCSITE'] },
    // Needs mesh vertices to locate the model, so it runs on the main thread.
    needsGeometry: true,
    inputs: [
      {
        id: 'cadastralLot',
        kind: 'file',
        label: 'Cadastral lot (GeoJSON)',
        accept: '.geojson,.json,application/geo+json,application/json',
        help: 'Download from the URA site-information service: search the MK lot ' +
          'number, then "Download Cadastral Lot(s)". One file per check — a ' +
          'development spanning several lots needs them all in the one file.',
      },
      {
        id: 'vertices',
        kind: 'text',
        label: 'Or three surveyed vertices (SVY21)',
        placeholder: 'easting, northing per line',
        help: 'The fallback when the lot is not in the cadastral database. Three ' +
          'points, checked against the site boundary to ±20 mm.',
      },
    ],
    load: () => import('./geo-referencing/index.js'),
  },
  {
    id: 'ura',
    title: 'URA requirements',
    authority: 'URA',
    summary:
      'Gross floor area parameters, the sanity rules URA applies to them, the ' +
      'elements a review needs, and the limits a submission must meet.',
    requires: {
      ruleset: true,
      entities: ['IFCSPACE', 'IFCGEOGRAPHICELEMENT', 'IFCBUILDINGELEMENTPROXY', 'IFCSITE'],
    },
    inputs: [
      {
        id: 'gateway',
        kind: 'select',
        label: 'Submission gateway',
        // Defaults to the stricter gateway: a forgotten selection should
        // over-report rather than quietly skip requirements.
        default: 'construction',
        options: [
          { value: 'construction', label: 'Construction Gateway' },
          { value: 'design', label: 'Design Gateway' },
        ],
        help: 'The Design Gateway asks for considerably less than the Construction ' +
          'Gateway. Rules belonging to the other gateway are not run.',
      },
    ],
    load: () => import('./ura/index.js'),
  },
  {
    id: 'bca',
    title: 'BCA requirements',
    authority: 'BCA',
    summary:
      'Building and Construction Authority requirements — accessibility, barrier-free ' +
      'provision and related rules, evaluated from the model.',
    requires: {
      ruleset: true,
      entities: ['IFCSPACE', 'IFCDOOR', 'IFCSTAIR', 'IFCRAMP', 'IFCRAILING'],
    },
    experimental: true,
    load: () => import('./bca/index.js'),
  },
  {
    id: 'space-geometry',
    title: 'Space geometry',
    authority: 'IFC-SG',
    summary:
      'Every IfcSpace carries a geometric representation. A room Revit could not ' +
      'enclose exports with none: it cannot be reviewed or measured, and an Area_GFA ' +
      'space without geometry drops out of the GFA computation.',
    requires: { entities: ['IFCSPACE'] },
    load: () => import('./space-geometry/index.js'),
  },
];

/** Every check, in menu order. */
export function all() {
  return MANIFEST;
}

export function byId(id) {
  return MANIFEST.find((c) => c.id === id) || null;
}

/** Menu grouping: [{ authority, checks }], authorities in manifest order. */
export function byAuthority() {
  const groups = new Map();
  for (const check of MANIFEST) {
    if (!groups.has(check.authority)) groups.set(check.authority, []);
    groups.get(check.authority).push(check);
  }
  return [...groups.entries()].map(([authority, checks]) => ({ authority, checks }));
}

/**
 * Every IFC entity any check may need, whether or not it has been loaded.
 *
 * The indexer walks the model once at load time and the parsed IFC is released
 * straight afterwards, so an entity missed here cannot be recovered later
 * without re-reading the file. Declaring requirements in the manifest rather
 * than inside the module is what makes lazy loading safe.
 */
export function requiredEntities() {
  const entities = new Set();
  for (const check of MANIFEST) {
    for (const e of (check.requires && check.requires.entities) || []) {
      entities.add(e.toUpperCase());
    }
  }
  return entities;
}

/** Every `kind: 'custom'` input, as [{ key: '<checkId>.<inputId>', check, input }]. */
export function customInputs() {
  return MANIFEST.flatMap((check) => (check.inputs || [])
    .filter((input) => input.kind === 'custom')
    .map((input) => ({ key: check.id + '.' + input.id, check, input })));
}

// ------------------------------------------------------------------- loading

/** id -> loaded CheckModule */
const loaded = new Map();
/** id -> 'idle' | 'loading' | 'ready' | 'error' */
const status = new Map();
/** id -> in-flight promise, so two concurrent runs share one import. */
const inFlight = new Map();

export function stateOf(id) {
  return status.get(id) || 'idle';
}

export function isLoaded(id) {
  return loaded.has(id);
}

/** The loaded module for a check, or null if it has never been loaded. */
export function peek(id) {
  return loaded.get(id) || null;
}

/** Every module loaded so far, as [{ meta, module }]. */
export function loadedModules() {
  return [...loaded.entries()].map(([id, module]) => ({ meta: byId(id), module }));
}

/**
 * Loads a check module, caching it for the session.
 * @returns {Promise<import('./types.js').CheckModule>}
 */
export function load(id) {
  if (loaded.has(id)) return Promise.resolve(loaded.get(id));
  if (inFlight.has(id)) return inFlight.get(id);

  const meta = byId(id);
  if (!meta) return Promise.reject(new Error('Unknown check "' + id + '".'));

  status.set(id, 'loading');
  const promise = meta.load()
    .then((mod) => {
      const check = mod.default || mod.check;
      // Fail at load time rather than mid-run with a confusing stack.
      if (!check || typeof check.run !== 'function') {
        throw new Error('Check "' + id + '" does not export a module with a run() function.');
      }
      loaded.set(id, check);
      status.set(id, 'ready');
      inFlight.delete(id);
      return check;
    })
    .catch((err) => {
      status.set(id, 'error');
      inFlight.delete(id);
      throw err;
    });

  inFlight.set(id, promise);
  return promise;
}
