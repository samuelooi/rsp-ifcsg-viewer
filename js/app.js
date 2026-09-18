/**
 * RSP IFC-SG Viewer & Checker — application wiring.
 *
 * Presets come straight from the CORENET X industry mapping: every component the
 * agencies query for becomes a clickable target, and every property they require
 * becomes a colour-by-value query underneath it.
 *
 * Several IFC files can be open at once and are treated as one federated model;
 * elements are identified by `modelID:expressID` throughout.
 */

import { Viewer } from './viewer.js';
import { buildIndex, mergeIndexes } from './ifc-index.js';
import { DASHBOARD_ENTITIES, computeDashboard, formatValue as fmtNum } from './dashboard.js';
import { measure, project, formatBytes, LEVEL } from './memory.js';
import {
  loadRuleset, selectElements, groupByValue, runCheck, evaluate,
  describeSubtypes, matchesTarget, formatValue, isEmptyValue,
  STATUS, STATUS_LABEL, GATEWAY, GATEWAY_ORDER, GATEWAY_LABEL, AGENCY_ALL, appliesToAgency,
} from './ifcsg.js';
import { buildTransform } from './geo/georef.js';
import * as registry from './checks/registry.js';
import { runChecks, totalsOf } from './checks/runner.js';
import {
  SEVERITY, SEVERITY_LABEL, SEVERITY_COLOUR, SEVERITY_ORDER, worstOf,
} from './checks/severity.js';
import { esc, hex } from './util/dom.js';

// ---------------------------------------------------------------------- colours

/** Categorical palette, tuned for readability against the dark canvas. */
const PALETTE = [
  0x4fa3d1, 0xe0a458, 0x77b255, 0xc06c84, 0x6c8ebf, 0xd68f5e,
  0x8fbf6c, 0xa384c4, 0x5fb3a3, 0xd4785e, 0x7f9cd1, 0xbfa76c,
];
const MISSING_COLOUR = 0xd16a4f;   // same hue as --danger: an unset value is a gap
const SINGLE_COLOUR = 0x4fa3d1;

/** Where the selected checks are remembered between sessions. */
const SELECTION_KEY = 'rsp-ifcsg.checks';

// ------------------------------------------------------------------------ state

let ruleset = null;
let viewer = null;

/** modelID -> per-model index, merged into `index` for all queries. */
const indexes = new Map();
let index = null;
/**
 * modelID -> the entities the indexer was asked for when that model loaded. An
 * entity requested later (a new value preset) is missing from models already open.
 */
const indexedWith = new Map();

/** target.id -> element count in the loaded models. */
const counts = new Map();

/**
 * The active query: a component group (one agency + component, with every
 * workbook selector that names it), and optionally one property under one of
 * its entities. `entity` and `req` are null while the whole component is shown.
 */
let selection = null;      // { group, entity, req }
let legend = [];           // [{ label, colour, elements, missing }]
let soloIndex = -1;
let contextMode = 'ghost'; // 'ghost' | 'hidden' | 'normal'

/** Results of the last run, one entry per selected check. */
let checkOutcomes = [];
/** Check ids the user has ticked in the menu. */
let selectedChecks = new Set();
/** "<checkId>.<inputId>" -> the value the user supplied (a string, or {name, text}). */
const checkInputs = new Map();
/** "<checkId>.<inputId>" -> loaded module for a `kind: 'custom'` input. */
const customInputModules = new Map();
let checkRunning = false;
/** Aborts an in-flight run when the model changes or a new run starts. */
let checkAbort = null;

let sectionArmed = false;  // a click on a model face places a new section cut
let planActive = null;     // { name, y } while a plan view is showing

// Query-tree hierarchy filters, macro to micro: Gateway narrows Authority
// narrows Component. A gateway is always selected — Construction by default,
// since it is checked for everything. '' means "all" for the authority tier.
let gatewayFilter = GATEWAY.CONSTRUCTION;
let agencyFilter = '';

// Visibility policy. The viewer holds the resulting set; these two own the intent.
const manualHidden = new Set();   // element keys hidden via the context menu
let spacesVisible = false;        // IfcSpace volumes obscure everything by default

// --------------------------------------------------------------------- elements

const $ = (id) => document.getElementById(id);
const el = {
  filename: $('filename'), modelPicker: $('model-picker'), badge: $('ruleset-badge'),
  btnOpen: $('btn-open'), btnOpenEmpty: $('btn-open-empty'), btnReset: $('btn-reset'),
  fileInput: $('file-input'), dropzone: $('dropzone'),
  loading: $('loading'), barFill: $('bar-fill'), loadingLabel: $('loading-label'),
  toast: $('toast'), left: $('left'), models: $('models'),
  gwBubbles: $('gw-bubbles'), agencyBubbles: $('agency-bubbles'),
  fSearch: $('f-search'), fPresent: $('f-present'),
  tree: $('tree'), legend: $('legend'), legendTitle: $('legend-title'), legendRows: $('legend-rows'),
  btnClearQuery: $('btn-clear-query'),
  checkMenu: $('check-menu'),
  btnRunCheck: $('btn-run-check'), btnColourStatus: $('btn-colour-status'),
  summary: $('summary'), issues: $('issues'),
  panel: $('panel'), panelBody: $('panel-body'), panelClose: $('panel-close'),
  toolCollapse: $('tool-collapse'), toolGhost: $('tool-ghost'), toolSpaces: $('tool-spaces'),
  toolShowAll: $('tool-showall'), toolWireframe: $('tool-wireframe'), toolFit: $('tool-fit'),
  toolSection: $('tool-section'), toolLevels: $('tool-levels'),
  sectionsBar: $('sections-bar'), levelsPanel: $('levels-panel'), planBadge: $('plan-badge'),
  toolSurvey: $('tool-survey'),
  ctxmenu: $('ctxmenu'),
  btnDash: $('btn-dash'), dash: $('dash'), dashBody: $('dash-body'),
  dashSub: $('dash-sub'), dashSeg: $('dash-seg'), dashClose: $('dash-close'),
  mem: $('mem'), memFill: $('mem-fill'), memVal: $('mem-val'),
};

/** Which breakdown the dashboard cards show: 'level' | 'file' | 'none'. */
let dashBreakdown = 'level';

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove('visible'), 5200);
}

function setProgress(pct, label) {
  el.barFill.style.width = Math.min(pct, 100) + '%';
  if (label) el.loadingLabel.textContent = label;
}

// ---------------------------------------------------------------------- memory

/** Set once the meter enters the danger band, so the warning fires once per crossing. */
let memoryWarned = false;

/** Refreshes the top-bar memory meter from the current estimate. */
function renderMemory() {
  if (!viewer) return;
  const m = measure(viewer);
  const pct = Math.min(100, Math.round(m.ratio * 100));

  el.memFill.style.width = pct + '%';
  el.memVal.textContent = `${formatBytes(m.total)} / ${formatBytes(m.budget)}`;
  el.mem.classList.toggle('warn', m.level === LEVEL.WARN);
  el.mem.classList.toggle('danger', m.level === LEVEL.DANGER);
  el.mem.title = [
    `Estimated tab memory: ${formatBytes(m.total)} of a ${formatBytes(m.budget)} budget (${pct}%)`,
    `Geometry buffers: ${formatBytes(m.geometry)}`,
    `web-ifc wasm heap: ${formatBytes(m.wasm)}`,
    m.jsHeap === null
      ? 'JavaScript heap: not reported by this browser'
      : `JavaScript heap: ${formatBytes(m.jsHeap)}`,
    '',
    'Geometry and wasm figures are exact. The ceiling is a budget rather than a',
    'hard limit; override it with ?membudget=<GiB> in the URL.',
  ].join('\n');

  if (m.level === LEVEL.DANGER) {
    if (!memoryWarned) {
      memoryWarned = true;
      toast(`Memory is at ${pct}% of the ${formatBytes(m.budget)} budget. ` +
        'Close a model before adding more, or the browser tab may run out of memory.');
    }
  } else {
    memoryWarned = false;
  }
}

// ------------------------------------------------------------------------- boot

async function init() {
  viewer = new Viewer($('viewer-container'));
  viewer.onPick(onPick);
  viewer.onContextMenu(openContextMenu);

  wireUI();
  renderMemory();
  // The JS heap moves on its own, so keep the meter live rather than event-driven.
  setInterval(renderMemory, 2000);

  selectedChecks = loadSelection();
  renderCheckMenu();

  try {
    ruleset = await loadRuleset();

    // The model is walked once and the parsed IFC is released straight after, so
    // every entity any feature might want has to be declared before indexing.
    // The dashboard reports on entities the architectural ruleset does not cover
    // (refuse capacity lives on IfcTank, which is MEP), and a check that has not
    // been loaded yet still declares its entities in the registry manifest.
    for (const e of DASHBOARD_ENTITIES) ruleset.entities.add(e);
    for (const e of registry.requiredEntities()) ruleset.entities.add(e);
    // Custom inputs can ask for entities too (a value preset on IfcTank), and
    // those are only known once their saved data has loaded.
    await loadCustomInputs();

    // The element inspector reads live pass/fail from this module, so it is
    // fetched at boot rather than on first run. It is small, and not awaiting it
    // keeps it off the critical path. Every other check stays lazy.
    registry.load('ifc-values').then(renderCheckMenu).catch((err) => {
      console.error('The IFC values check could not be loaded:', err);
    });

    el.badge.innerHTML =
      // Construction holds every component; counting all targets would list the
      // Design Gateway ones twice.
      `IFC-SG <b>${ruleset.meta.requirements}</b> rules · ` +
      `<b>${ruleset.targets.filter((t) => t.gateway === GATEWAY.CONSTRUCTION).length}</b> components`;
    el.badge.title =
      `${ruleset.meta.source}\nSheet: ${ruleset.meta.sheet}\nGenerated ${ruleset.meta.generated}`;
    refreshFilters();
  } catch (err) {
    console.error(err);
    el.badge.textContent = 'Ruleset failed to load';
    el.badge.classList.add('err');
    el.tree.innerHTML =
      `<div class="empty-note">Could not load <code>data/ifcsg-rules.json</code>.<br><br>
       This page must be served over http:// (not opened as a file). Run a static
       server from the project folder, then reload.</div>`;
    toast('IFC-SG ruleset could not be loaded — queries are unavailable.');
  }
}

/** Loads every custom check input and indexes the entities they declare. */
async function loadCustomInputs() {
  await Promise.all(registry.customInputs().map(async ({ key, input }) => {
    try {
      const mod = await input.load();
      customInputModules.set(key, mod);
      if (typeof mod.requiredEntities === 'function') {
        for (const e of await mod.requiredEntities()) ruleset.entities.add(String(e).toUpperCase());
      }
    } catch (err) {
      // One broken input must not stop the ruleset from loading.
      console.error(`The "${input.label}" input could not be loaded:`, err);
    }
  }));
  renderCheckMenu();
}

/** What a custom check input may use. */
const customInputApi = {
  index: () => index,
  isIndexed: (canon) => indexedWith.size > 0 &&
    [...indexedWith.values()].every((set) => set.has(canon)),
  requireEntity: (canon) => {
    if (ruleset) ruleset.entities.add(canon);
  },
  showInModel: (...args) => shellActions.showInModel(...args),
  toast,
};

// -------------------------------------------------------------------- UI wiring

function wireUI() {
  el.btnOpen.addEventListener('click', () => el.fileInput.click());
  el.btnOpenEmpty.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) loadFiles([...e.target.files]);
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    window.addEventListener(evt, (e) => {
      e.preventDefault();
      el.dropzone.classList.add('visible', 'dragover');
    });
  });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    if (e.target !== el.dropzone) return;
    el.dropzone.classList.remove('dragover');
    if (viewer.hasModels) el.dropzone.classList.remove('visible');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    el.dropzone.classList.remove('dragover');
    if (viewer.hasModels) el.dropzone.classList.remove('visible');
    const files = [...e.dataTransfer.files];
    if (files.length) loadFiles(files);
  });

  el.panelClose.addEventListener('click', () => el.panel.classList.remove('visible'));
  el.btnReset.addEventListener('click', () => viewer.fit());
  el.toolFit.addEventListener('click', () => viewer.fit());

  el.toolCollapse.addEventListener('click', () => el.left.classList.toggle('collapsed'));

  el.toolGhost.addEventListener('click', () => {
    contextMode = contextMode === 'ghost' ? 'hidden' : contextMode === 'hidden' ? 'normal' : 'ghost';
    el.toolGhost.title = `Context: ${contextMode} (click to change)`;
    el.toolGhost.classList.toggle('active', contextMode !== 'normal');
    viewer.setContextMode(contextMode);
  });
  el.toolGhost.classList.add('active');
  el.toolGhost.title = 'Context: ghost (click to change)';

  el.toolSpaces.addEventListener('click', () => setSpacesVisible(!spacesVisible));
  el.toolShowAll.addEventListener('click', showAll);

  wireSectionTool();
  wireLevelsTool();

  // The survey outlines are drawn by a check; the rail only clears them, so it
  // does nothing until there is something to clear.
  el.toolSurvey.addEventListener('click', () => {
    if (!viewer.hasSurveyOverlays) {
      toast('Run the geo-referencing check with a cadastral lot file to draw survey outlines.');
      return;
    }
    viewer.clearSurveyOverlays();
    el.toolSurvey.classList.remove('active');
    el.toolSurvey.title = 'No survey outlines drawn';
  });

  let wireframe = false;
  el.toolWireframe.addEventListener('click', () => {
    wireframe = !wireframe;
    el.toolWireframe.classList.toggle('active', wireframe);
    viewer.setWireframe(wireframe);
  });

  el.fPresent.addEventListener('change', refreshFilters);

  // The model name drops down the loaded-models list; with nothing loaded it
  // goes straight to the file picker instead.
  el.filename.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!viewer.hasModels) {
      el.fileInput.click();
      return;
    }
    el.modelPicker.classList.toggle('open');
  });
  el.models.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => el.modelPicker.classList.remove('open'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') el.modelPicker.classList.remove('open');
  });
  let searchTimer;
  el.fSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshFilters, 140);
  });

  el.btnClearQuery.addEventListener('click', clearQuery);

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      const tab = b.dataset.tab;
      $('tab-query').style.display = tab === 'query' ? 'flex' : 'none';
      $('tab-check').style.display = tab === 'check' ? 'flex' : 'none';
    });
  });

  el.btnRunCheck.addEventListener('click', doRunCheck);
  el.btnColourStatus.addEventListener('click', colourByStatus);

  el.btnDash.addEventListener('click', openDashboard);
  el.dashClose.addEventListener('click', () => el.dash.classList.remove('visible'));
  el.dashSeg.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      el.dashSeg.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      dashBreakdown = b.dataset.brk;
      renderDashboard();
    });
  });

  // Any left-click or Escape dismisses the context menu.
  document.addEventListener('click', closeContextMenu);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeContextMenu();
    closeLevelsPanel();
    if (sectionArmed) setSectionArmed(false);
  });
}

// ------------------------------------------------------------- section cuts

function setSectionArmed(on) {
  sectionArmed = on;
  el.toolSection.classList.toggle('active', on);
  el.toolSection.title = on
    ? 'Placing section cuts — click a face to cut along it, drag a cut to slide it, click the tool again to stop'
    : 'Section cut: click a face of the model (like Forma)';
  viewer.renderer.domElement.style.cursor = on ? 'crosshair' : '';
}

/**
 * Forma's section tool: a click on a face places a cut through it, snapped to
 * the nearest world axis; dragging an existing cut's handle slides it along
 * that axis. Anything else while armed still orbits and pans as usual, so the
 * camera can be moved between cuts without leaving the tool.
 */
function wireSectionTool() {
  el.toolSection.addEventListener('click', () => setSectionArmed(!sectionArmed));

  const canvas = viewer.renderer.domElement;
  let press = null; // where the left button went down, to tell a click from a drag
  // Capture phase, so this runs before OrbitControls' own pointerdown: a grab
  // on a handle is swallowed here and the camera never starts a gesture.
  canvas.addEventListener('pointerdown', (e) => {
    if (!sectionArmed || e.button !== 0) return;
    press = { x: e.clientX, y: e.clientY };
    if (viewer.grabSection(e) != null) e.stopImmediatePropagation();
  }, { capture: true });
  window.addEventListener('pointermove', (e) => {
    if (viewer.sectionDragging) viewer.dragSection(e);
  });
  window.addEventListener('pointerup', (e) => {
    if (!press) return;
    const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5;
    press = null;
    if (viewer.sectionDragging) {
      viewer.endSectionDrag();
      return;
    }
    if (moved || !sectionArmed) return; // an orbit, not a placement
    const face = viewer.raycastFace(e);
    if (!face) {
      toast('Click a face of the model to place a section cut.');
      return;
    }
    const id = viewer.addSectionAtFace(face, viewer.activeCamera.position);
    if (id != null) renderSectionsBar();
  });
}

function renderSectionsBar() {
  const list = viewer.sectionPlanes;
  if (!list.length) {
    el.sectionsBar.classList.remove('visible');
    el.sectionsBar.innerHTML = '';
    return;
  }
  el.sectionsBar.classList.add('visible');
  el.sectionsBar.innerHTML = `
    <div class="sb-head"><span>SECTION CUTS</span><span class="spacer"></span>
      <button data-act="clear">Clear all</button></div>
    ${list.map((s, i) => `
      <div class="sb-row" data-id="${s.id}">
        <span class="lbl">Section ${i + 1} <small>${s.axis.toUpperCase()} axis</small></span>
        <button data-act="flip" title="Flip cut side">&#8644;</button>
        <button data-act="remove" title="Remove">&times;</button>
      </div>`).join('')}`;

  el.sectionsBar.querySelector('[data-act="clear"]').addEventListener('click', () => {
    viewer.clearSectionPlanes();
    renderSectionsBar();
  });
  el.sectionsBar.querySelectorAll('.sb-row').forEach((row) => {
    const id = +row.dataset.id;
    row.querySelector('[data-act="flip"]').addEventListener('click', () => viewer.flipSectionPlane(id));
    row.querySelector('[data-act="remove"]').addEventListener('click', () => {
      viewer.removeSectionPlane(id);
      renderSectionsBar();
    });
  });
}

// -------------------------------------------------------------- plan / levels

/** Elements grouped by their storey name, from the currently merged index. */
function storeyGroups() {
  if (!index) return [];
  const map = new Map();
  for (const e of index.all) {
    if (!e.storey) continue;
    if (!map.has(e.storey)) map.set(e.storey, []);
    map.get(e.storey).push(e);
  }
  return [...map.entries()].map(([name, elements]) => ({ name, elements }));
}

/** Storeys with a sampled floor height, ordered top of the building first. */
function computeLevels() {
  return storeyGroups()
    .map((g) => ({ name: g.name, elements: g.elements, y: viewer.sampleFloorY(g.elements) }))
    .filter((g) => g.y !== null)
    .sort((a, b) => b.y - a.y);
}

function wireLevelsTool() {
  el.toolLevels.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.levelsPanel.classList.contains('visible')) closeLevelsPanel();
    else openLevelsPanel();
  });
  document.addEventListener('click', closeLevelsPanel);
}

function openLevelsPanel() {
  if (!index) {
    toast('Load an IFC model first.');
    return;
  }
  const levels = computeLevels();
  if (!levels.length) {
    toast('No building storeys with locatable elements were found.');
    return;
  }

  el.levelsPanel.innerHTML = `
    <div class="lvl-head">PLAN VIEW BY LEVEL</div>
    ${planActive ? `<button data-act="exit"><span class="lname">Exit plan view<small>Return to 3D</small></span></button><div class="sep"></div>` : ''}
    ${levels.map((l) => `
      <button data-name="${esc(l.name)}" class="${planActive && planActive.name === l.name ? 'active' : ''}">
        <span class="lname">${esc(l.name)}<small>${l.elements.length} elements · cut at level +1.2 m</small></span>
      </button>`).join('')}`;

  const r = el.toolLevels.getBoundingClientRect();
  el.levelsPanel.style.left = Math.min(r.right + 6, window.innerWidth - 226) + 'px';
  el.levelsPanel.style.top = Math.max(Math.min(r.top, window.innerHeight - 340), 8) + 'px';
  el.levelsPanel.classList.add('visible');

  el.levelsPanel.querySelectorAll('button[data-name]').forEach((b) => {
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const l = levels.find((x) => x.name === b.dataset.name);
      enterPlan(l);
      closeLevelsPanel();
    });
  });
  const exitBtn = el.levelsPanel.querySelector('[data-act="exit"]');
  if (exitBtn) {
    exitBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      exitPlan();
      closeLevelsPanel();
    });
  }
}

function closeLevelsPanel() {
  el.levelsPanel.classList.remove('visible');
}

function enterPlan(level) {
  if (!level || !viewer.enterPlanView()) {
    toast('Nothing visible to frame in plan view.');
    return;
  }
  const y = level.y + 1.2;
  viewer.setPlanClip(y);
  planActive = { name: level.name, y };
  el.toolLevels.classList.add('active');
  renderPlanBadge();
}

function exitPlan() {
  if (!planActive) return;
  viewer.exitPlanView();
  viewer.clearPlanClip();
  planActive = null;
  el.toolLevels.classList.remove('active');
  renderPlanBadge();
}

function renderPlanBadge() {
  if (!planActive) {
    el.planBadge.style.display = 'none';
    el.planBadge.innerHTML = '';
    return;
  }
  el.planBadge.style.display = 'flex';
  el.planBadge.innerHTML = `Plan · ${esc(planActive.name)}<button title="Exit plan view">&times;</button>`;
  el.planBadge.querySelector('button').addEventListener('click', exitPlan);
}

// ------------------------------------------------------------------ model load

async function loadFiles(files) {
  const ifcFiles = files.filter((f) => f.name.toLowerCase().endsWith('.ifc'));
  const skipped = files.length - ifcFiles.length;
  if (!ifcFiles.length) {
    toast("No .ifc files in that selection.");
    return;
  }

  // Warn before parsing: a parse cannot be interrupted, and a file that does
  // not fit takes the whole tab down with it. The user can still go ahead.
  const now = measure(viewer);
  const forecast = project(now, ifcFiles);
  if (forecast.level === LEVEL.DANGER) {
    toast(`${formatBytes(forecast.fileBytes)} of IFC is expected to need about ` +
      `${formatBytes(forecast.peak)} of memory against a ${formatBytes(now.budget)} budget. ` +
      'The browser tab may run out of memory while loading.');
  }

  el.dropzone.classList.remove('visible');
  el.loading.classList.add('visible');

  clearQuery();
  clearCheckResults();

  let loaded = 0;
  for (const [i, file] of ifcFiles.entries()) {
    const base = (i / ifcFiles.length) * 100;
    const span = 100 / ifcFiles.length;
    const label = ifcFiles.length > 1 ? ` (${i + 1}/${ifcFiles.length})` : '';
    setProgress(base + span * 0.05, `Reading ${file.name}…`);

    try {
      const entry = await viewer.load(file, (pct) =>
        setProgress(base + span * (pct / 100) * 0.6, `Parsing geometry${label}…`));

      if (ruleset) {
        setProgress(base + span * 0.65, `Indexing properties${label}…`);
        // Yield so the progress bar paints before the synchronous index walk.
        await new Promise((r) => setTimeout(r, 20));
        indexedWith.set(entry.modelID, new Set(ruleset.entities));
        indexes.set(entry.modelID, buildIndex(viewer.api, entry.modelID, ruleset,
          (msg, pct) => setProgress(base + span * (0.65 + (pct / 100) * 0.34), msg + label)));
      }
      // Everything the mapping needs is now in the index, and nothing after this
      // reads the wasm model — so hand that memory back before the next file.
      viewer.releaseModelData(entry.modelID);
      renderMemory();
      loaded++;
    } catch (err) {
      console.error(err);
      toast(`Could not load ${file.name}. It may be an unsupported IFC schema or corrupted.`);
    }
  }

  if (!loaded) {
    el.loading.classList.remove('visible');
    if (!viewer.hasModels) el.dropzone.classList.add('visible');
    return;
  }

  rebuildIndex();
  viewer.fit();
  setProgress(100, 'Done');
  if (skipped) toast(`${skipped} file${skipped > 1 ? 's were' : ' was'} skipped — not .ifc.`);
  setTimeout(() => el.loading.classList.remove('visible'), 250);
}

/** Recomputes the merged index, target counts and all dependent UI. */
function rebuildIndex() {
  // The set of storeys and their geometry can change entirely with the model
  // set, so a stale plan cut would show the wrong thing rather than nothing.
  if (planActive) exitPlan();

  index = indexes.size ? mergeIndexes([...indexes.values()]) : null;

  counts.clear();
  if (index && ruleset) {
    for (const t of ruleset.targets) counts.set(t.id, selectElements(index, t).length);
  }

  const names = viewer.entries.map((e) => e.name);
  el.filename.querySelector('.fname').textContent = names.length === 0 ? 'No model loaded'
    : names.length === 1 ? names[0]
      : `${names.length} models`;
  el.filename.classList.toggle('has-file', names.length > 0);
  el.filename.title = names.length ? names.join('\n') : 'Add an IFC file';
  if (!names.length) el.modelPicker.classList.remove('open');
  el.btnReset.disabled = !viewer.hasModels;
  // Check inputs such as the preset editor read from the index, so redraw them.
  renderCheckMenu();
  el.btnDash.disabled = !index;
  if (!index) el.dash.classList.remove('visible');

  renderModels();
  renderTree();
  applyVisibility();
  renderMemory();

  if (index && ![...counts.values()].some((n) => n > 0)) {
    toast('No IFC-SG mapped components found. The model may not use SGPset property sets.');
  }
}

function renderModels() {
  const entries = viewer.entries;
  if (!entries.length) {
    el.models.innerHTML = '';
    return;
  }
  el.models.innerHTML = entries.map((e) => {
    const n = indexes.get(e.modelID)?.count ?? 0;
    return `
      <div class="mrow${e.visible ? '' : ' off'}" data-m="${e.modelID}">
        <button class="icon-btn ${e.visible ? 'on' : ''}" data-act="vis" title="Show / hide this model">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/>
          </svg>
        </button>
        <span class="mname" title="${esc(e.name)}">${esc(e.name)}<small>${n} mapped elements</small></span>
        <button class="icon-btn" data-act="del" title="Close this model">&times;</button>
      </div>`;
  }).join('');

  el.models.querySelectorAll('.mrow').forEach((row) => {
    const modelID = +row.dataset.m;
    row.querySelector('[data-act="vis"]').addEventListener('click', () => {
      const entry = viewer.models.get(modelID);
      viewer.setModelVisible(modelID, !entry.visible);
      renderModels();
    });
    row.querySelector('[data-act="del"]').addEventListener('click', () => removeModel(modelID));
  });
}

function removeModel(modelID) {
  // Drop anything that referenced this model before the elements disappear.
  for (const key of [...manualHidden]) {
    if (key.startsWith(modelID + ':')) manualHidden.delete(key);
  }
  indexes.delete(modelID);
  indexedWith.delete(modelID);
  viewer.removeModel(modelID);
  clearQuery();
  clearCheckResults();
  rebuildIndex();
  if (!viewer.hasModels) el.dropzone.classList.add('visible');
}

// -------------------------------------------------------------------- visibility

/** Every IfcSpace in the merged index. */
function spaceElements() {
  return index ? (index.byEntity.get('IFCSPACE') || []) : [];
}

/** Pushes the current visibility policy — manual hides plus the space rule. */
function applyVisibility() {
  if (!index) {
    viewer.setHidden([]);
  } else {
    const hidden = [];
    for (const e of index.all) if (manualHidden.has(e.key)) hidden.push(e);
    if (!spacesVisible) {
      for (const e of spaceElements()) if (!manualHidden.has(e.key)) hidden.push(e);
    }
    viewer.setHidden(hidden);
  }

  const spaces = spaceElements().length;
  el.toolSpaces.classList.toggle('active', spacesVisible);
  el.toolSpaces.title = spaces
    ? `${spacesVisible ? 'Hide' : 'Show'} ${spaces} IfcSpace volume${spaces > 1 ? 's' : ''}`
    : 'No IfcSpace elements in this model';

  const hiddenCount = manualHidden.size;
  el.toolShowAll.classList.toggle('active', hiddenCount > 0);
  el.toolShowAll.title = hiddenCount
    ? `Show all — ${hiddenCount} element${hiddenCount > 1 ? 's' : ''} hidden`
    : 'Show all (nothing is hidden)';
}

function setSpacesVisible(on) {
  spacesVisible = on;
  applyVisibility();
}

function showAll() {
  manualHidden.clear();
  spacesVisible = true;
  for (const e of viewer.entries) viewer.setModelVisible(e.modelID, true);
  applyVisibility();
  renderModels();
}

function hideElements(elements) {
  for (const e of elements) manualHidden.add(e.key);
  applyVisibility();
}

/** Hides everything except the given elements. */
function isolateElements(elements) {
  if (!index) return;
  const keep = new Set(elements.map((e) => e.key));
  manualHidden.clear();
  for (const e of index.all) if (!keep.has(e.key)) manualHidden.add(e.key);
  // An explicit isolate overrides the space rule, or isolating a space shows nothing.
  spacesVisible = true;
  applyVisibility();
}

// ---------------------------------------------------------------- context menu

function openContextMenu(hit, x, y) {
  const item = pickedElement(hit);
  const hiddenCount = manualHidden.size;

  const parts = [];
  if (item) {
    parts.push(`<div class="ctx-head">${esc(item.name || item.entity)}
      <small>${esc(item.entity)}${item.storey ? ' · ' + esc(item.storey) : ''}</small></div>`);
    parts.push(`<button data-act="hide">Hide element</button>`);
    parts.push(`<button data-act="hide-type">Hide all ${esc(item.entity)}
      <span class="hint">${(index.byEntity.get(item.canonicalEntity) || []).length}</span></button>`);
    parts.push(`<button data-act="isolate">Isolate element</button>`);
    parts.push(`<div class="sep"></div>`);
    parts.push(`<button data-act="select">Show properties</button>`);
    parts.push(`<div class="sep"></div>`);
  }
  // The elements the current query colours (a soloed legend row narrows it), so
  // the picked-out components can be viewed on their own.
  const queried = legend
    .filter((g, i) => soloIndex < 0 || soloIndex === i)
    .flatMap((g) => g.elements);
  parts.push(`<button data-act="isolate-query"${queried.length ? '' : ' disabled'}>Isolate selected components
    ${queried.length ? `<span class="hint">${queried.length}</span>` : ''}</button>`);
  parts.push(`<button data-act="showall"${hiddenCount ? '' : ' disabled'}>Show all
    ${hiddenCount ? `<span class="hint">${hiddenCount} hidden</span>` : ''}</button>`);
  parts.push(`<button data-act="fit">Fit view</button>`);

  el.ctxmenu.innerHTML = parts.join('');
  el.ctxmenu.classList.add('visible');

  // Keep the menu inside the window.
  const r = el.ctxmenu.getBoundingClientRect();
  el.ctxmenu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  el.ctxmenu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';

  el.ctxmenu.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      switch (b.dataset.act) {
        case 'hide': hideElements([item]); break;
        case 'hide-type': hideElements(index.byEntity.get(item.canonicalEntity) || []); break;
        case 'isolate': isolateElements([item]); break;
        case 'isolate-query': isolateElements(queried); break;
        case 'select': showElement(item); break;
        case 'showall': showAll(); break;
        case 'fit': viewer.fit(); break;
      }
    });
  });
}

function closeContextMenu() {
  el.ctxmenu.classList.remove('visible');
}

// ------------------------------------------------------------------ query tree

/** Search + "present in model" — the filters orthogonal to the hierarchy. */
function matchesSecondaryFilters(t) {
  const q = el.fSearch.value.trim().toLowerCase();
  const onlyPresent = el.fPresent.checked && index;

  if (onlyPresent && !(counts.get(t.id) > 0)) return false;
  if (q) {
    const hay = [t.component, t.entity, describeSubtypes(t.subtypes),
      ...t.requirements.map((r) => r.prop + ' ' + r.pset)].join(' ').toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function visibleTargets() {
  const list = ruleset.targets.filter((t) =>
    (!gatewayFilter || t.gateway === gatewayFilter) &&
    appliesToAgency(t, agencyFilter) &&
    matchesSecondaryFilters(t));
  // With an authority chosen, its own components read first and the ones every
  // authority shares follow. The sort is stable, so the order within each
  // group is unchanged.
  if (agencyFilter) {
    list.sort((a, b) =>
      GATEWAY_ORDER.indexOf(a.gateway) - GATEWAY_ORDER.indexOf(b.gateway) ||
      (a.agency === AGENCY_ALL) - (b.agency === AGENCY_ALL));
  }
  return list;
}

/** Re-renders every filter-driven part of the query tab: bubbles, then the tree. */
function refreshFilters() {
  renderGatewayBubbles();
  renderAgencyBubbles();
  renderTree();
}

/** One row of pill filters: `items` is [{id, label, n}], id '' is the "all" bubble. */
function renderBubbles(container, items, activeId, onClick) {
  container.innerHTML = items.map((it) => `
    <button class="bubble${it.id === activeId ? ' active' : ''}${it.id && !it.n ? ' zero' : ''}"
            data-id="${esc(it.id)}">${esc(it.label)}<span class="bc">${it.n}</span></button>`).join('');
  container.querySelectorAll('.bubble').forEach((b) => {
    b.addEventListener('click', () => onClick(b.dataset.id));
  });
}

/** Gateway is the top tier: scoped only by the secondary filters, not by authority. */
function renderGatewayBubbles() {
  if (!el.gwBubbles) return;
  const base = ruleset.targets.filter(matchesSecondaryFilters);
  const counts_ = new Map();
  for (const t of base) counts_.set(t.gateway, (counts_.get(t.gateway) || 0) + 1);

  // No "All" here: the Construction Gateway already is everything.
  const items = GATEWAY_ORDER.map((g) => ({ id: g, label: GATEWAY_LABEL[g], n: counts_.get(g) || 0 }));
  renderBubbles(el.gwBubbles, items, gatewayFilter, (id) => {
    gatewayFilter = id;
    // A drill-down: if the authority chosen below no longer has anything under
    // this gateway, drop back to "all authorities" rather than showing nothing.
    if (agencyFilter && !ruleset.targets.some((t) =>
      t.agency === agencyFilter && (!gatewayFilter || t.gateway === gatewayFilter) && matchesSecondaryFilters(t))) {
      agencyFilter = '';
    }
    refreshFilters();
  });
}

/** Authority is the second tier: scoped by whichever gateway is currently selected. */
function renderAgencyBubbles() {
  if (!el.agencyBubbles) return;
  const base = ruleset.targets.filter((t) =>
    (!gatewayFilter || t.gateway === gatewayFilter) && matchesSecondaryFilters(t));
  // "ALL" is not an authority but a component every authority queries, so it
  // gets no bubble of its own and is counted under each of the others.
  const agencies = ruleset.agencies.filter((a) => a !== AGENCY_ALL);
  const items = [
    { id: '', label: 'All', n: base.length },
    ...agencies.map((a) => ({ id: a, label: a, n: base.filter((t) => appliesToAgency(t, a)).length })),
  ];
  renderBubbles(el.agencyBubbles, items, agencyFilter, (id) => {
    agencyFilter = id;
    renderAgencyBubbles();
    renderTree();
  });
}

// ------------------------------------------------------------ component groups

/**
 * One agency + component, with every workbook selector row that names it.
 *
 * The workbook lists a component once per (entity, subtypes) row, and those
 * rows overlap — "Railing" has both IfcRailing[any] and IfcRailing[GUARDRAIL].
 * The user thinks in components, so the rows are folded together here and the
 * elements deduplicated, which is what makes the counts add up.
 *
 * @typedef {object} ComponentGroup
 * @property {string} key       agency|component
 * @property {string} agency
 * @property {string} component
 * @property {object[]} targets
 */

/** Folds targets (already scoped and ordered) into component groups. */
/**
 * The targets in scope folded into one group per component. Several
 * authorities query the same component (Door: BCA, NEA and SCDF), so a
 * component is one bubble whatever asks for it; `agencies` records who does.
 */
function componentGroups(targets) {
  const groups = new Map();
  for (const t of targets) {
    let g = groups.get(t.component);
    if (!g) groups.set(t.component, (g = { key: t.component, component: t.component, agencies: [], targets: [] }));
    if (!g.agencies.includes(t.agency)) g.agencies.push(t.agency);
    g.targets.push(t);
  }
  return [...groups.values()].sort((a, b) =>
    a.component.localeCompare(b.component, undefined, { sensitivity: 'base' }));
}

/** Every element any of the group's selectors matches, each once. */
function groupElements(group) {
  const seen = new Map();
  for (const t of group.targets) {
    for (const e of selectElements(index, t)) seen.set(e.key, e);
  }
  return [...seen.values()];
}

/**
 * What an element is, as the modeller declared it: entity plus subtype.
 * A USERDEFINED PredefinedType carries the real name on ObjectType.
 */
function elementKind(e) {
  const pt = e.predefinedType;
  const sub = pt && pt !== 'USERDEFINED' && pt !== 'NOTDEFINED' ? pt : (e.objectType || '');
  return sub ? `${e.entity} · ${sub}` : e.entity;
}

const reqId = (r) => (r.pset + '|' + r.prop).toUpperCase();

/**
 * The group's properties as one flat list. A requirement that several rows
 * repeat (Door: DOOR, then GATE, then the combined row; or BCA and SCDF both
 * asking for it) is listed once, with the entities it applies to.
 * @returns {Array<{req: object, entities: string[]}>}
 */
function groupProperties(group) {
  const list = new Map();
  for (const t of group.targets) {
    for (const r of t.requirements) {
      let p = list.get(reqId(r));
      if (!p) list.set(reqId(r), (p = { req: r, entities: [] }));
      if (!p.entities.includes(t.entity)) p.entities.push(t.entity);
    }
  }
  return [...list.values()].sort((a, b) =>
    a.req.prop.localeCompare(b.req.prop, undefined, { sensitivity: 'base' }) ||
    a.req.pset.localeCompare(b.req.pset, undefined, { sensitivity: 'base' }));
}

/** Elements of every selector in the group that asks for this requirement. */
function propertyElements(group, req) {
  const id = reqId(req);
  const seen = new Map();
  for (const t of group.targets) {
    if (!t.requirements.some((r) => reqId(r) === id)) continue;
    for (const e of selectElements(index, t)) seen.set(e.key, e);
  }
  return [...seen.values()];
}

// ------------------------------------------------------------------ query tree

/**
 * Two bubble sections: the components in scope, then — once one is chosen —
 * its properties, grouped under entity labels when it spans several entities.
 */
function renderTree() {
  if (!ruleset) return;
  const groups = componentGroups(visibleTargets());

  if (!groups.length) {
    const msg = agencyFilter
      ? 'No mapped components fall under this gateway/authority selection yet — try “All” authorities.'
      : index ? 'No mapped components match these filters.'
              : 'Load an IFC model, or untick “Only components present in model”.';
    el.tree.innerHTML = `<div class="empty-note">${msg}</div>`;
    return;
  }

  const active = selection ? selection.group.key : null;
  const parts = [`<div class="q-head">Components<span class="qc">${groups.length}</span></div>`];
  // One flat row: which authority asks is in the tooltip, not the layout.
  parts.push(`<div class="bubble-row plain">${groups.map((g) => {
    const n = index ? groupElements(g).length : null;
    const title = [g.agencies.map((a) => (a === AGENCY_ALL ? 'All authorities' : a)).join(', '),
      ...g.targets.map((t) => `${t.entity} · ${describeSubtypes(t.subtypes)}`)].join('\n');
    return `<button class="bubble comp${g.key === active ? ' active' : ''}${n === 0 ? ' zero' : ''}"
      data-g="${esc(g.key)}" title="${esc(title)}">${esc(g.component)}${
        n === null ? '' : `<span class="bc">${n}</span>`}</button>`;
  }).join('')}</div>`);

  let props = [];
  if (selection) {
    const group = selection.group;
    props = groupProperties(group);
    parts.push(`<div class="q-head">Properties · ${esc(group.component)}<span class="qc">${props.length}</span></div>`);
    if (!props.length) {
      parts.push('<div class="empty-note">The mapping lists no properties for this component — it only declares which elements belong to it.</div>');
    } else {
      parts.push(`<div class="bubble-row plain">${props.map(({ req: r, entities }, i) => {
        const on = selection.req && reqId(selection.req) === reqId(r);
        const hint = [r.pset, entities.join(', '), r.dataType, r.unit,
          r.accepted.kind === 'enum' ? 'accepted: ' + r.accepted.values.join(', ') : '',
          r.accepted.kind === 'spaceValues' ? 'Space Values list' : ''].filter(Boolean).join('\n');
        return `<button class="bubble prop${on ? ' active' : ''}" data-r="${i}"
          title="${esc(hint)}">${esc(r.prop)}<span class="bp">${esc(r.pset)}</span></button>`;
      }).join('')}</div>`);
    }
  }

  el.tree.innerHTML = parts.join('');

  el.tree.querySelectorAll('.bubble.comp').forEach((b) => {
    const g = groups.find((x) => x.key === b.dataset.g);
    b.addEventListener('click', () => {
      if (selection && selection.group.key === g.key && !selection.req) clearQuery();
      else selectComponent(g);
    });
  });
  el.tree.querySelectorAll('.bubble.prop').forEach((b) => {
    b.addEventListener('click', () => selectProperty(selection.group, props[+b.dataset.r].req));
  });
}

// ---------------------------------------------------------------- query / colour

/** Colours a component's elements by what each one is: entity plus subtype. */
function selectComponent(group) {
  if (!index) {
    toast('Load an IFC model first.');
    return;
  }
  const elements = groupElements(group);
  if (!elements.length) {
    toast(`No elements in the loaded models match ${group.component}.`);
    return;
  }
  // Querying spaces while spaces are hidden would colour nothing; the request to
  // see them is explicit, so honour it and let the toggle reflect the change.
  if (elements.some((e) => e.canonicalEntity === 'IFCSPACE') && !spacesVisible) setSpacesVisible(true);

  selection = { group, req: null };
  soloIndex = -1;

  const kinds = new Map();
  for (const e of elements) {
    const k = elementKind(e);
    if (!kinds.has(k)) kinds.set(k, []);
    kinds.get(k).push(e);
  }
  legend = [...kinds.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([label, els], i) => ({ label, colour: PALETTE[i % PALETTE.length], elements: els, missing: false }));
  el.legendTitle.innerHTML =
    `${esc(group.component)}<small>${esc(group.agencies.join(', '))} · ${elements.length} elements · ${kinds.size} kind${kinds.size === 1 ? '' : 's'}</small>`;

  renderTree();
  renderLegend();
  applyOverlay();
}

/** Colours the elements one property applies to by that property's value. */
function selectProperty(group, req) {
  const elements = propertyElements(group, req);
  if (!elements.length) {
    toast(`No elements in the loaded models carry ${req.pset}.${req.prop} under ${group.component}.`);
    return;
  }
  if (elements.some((e) => e.canonicalEntity === 'IFCSPACE') && !spacesVisible) setSpacesVisible(true);

  selection = { group, req };
  soloIndex = -1;

  let ci = 0;
  legend = groupByValue(elements, req).map((g) => ({
    label: g.label,
    colour: g.missing ? MISSING_COLOUR : PALETTE[ci++ % PALETTE.length],
    elements: g.elements,
    missing: g.missing,
  }));
  el.legendTitle.innerHTML =
    `${esc(req.prop)}<small>${esc(group.component)} · ${esc(req.pset)} · ${elements.length} elements</small>`;

  renderTree();
  renderLegend();
  applyOverlay();
}

function clearQuery() {
  selection = null;
  legend = [];
  soloIndex = -1;
  el.legend.classList.remove('visible');
  if (viewer) viewer.clearGroups();
  renderTree();
}

function renderLegend() {
  if (!legend.length) {
    el.legend.classList.remove('visible');
    return;
  }
  el.legend.classList.add('visible');
  el.legendRows.innerHTML = legend.map((g, i) => `
    <div class="lrow${soloIndex >= 0 && soloIndex !== i ? ' muted' : ''}" data-i="${i}">
      <span class="sw" style="background:${hex(g.colour)}"></span>
      <span class="lv" title="${esc(g.label)}">${esc(g.label)}</span>
      <span class="lc">${g.elements.length}</span>
    </div>`).join('');

  el.legendRows.querySelectorAll('.lrow').forEach((row) => {
    row.addEventListener('click', () => {
      const i = +row.dataset.i;
      // Click solos a value; clicking the soloed value again restores all.
      soloIndex = soloIndex === i ? -1 : i;
      renderLegend();
      applyOverlay();
    });
  });
}

/** Pushes the current legend to the viewer, honouring solo. */
function applyOverlay() {
  if (!viewer) return;
  const groups = legend
    .map((g, i) => ({ g, i }))
    .filter(({ i }) => soloIndex < 0 || soloIndex === i)
    .map(({ g }) => ({ elements: g.elements, colour: g.colour }));
  viewer.setQuery(groups, contextMode);
}

// ------------------------------------------------------------- compliance checks

/**
 * What a check module is allowed to do to the app.
 *
 * Modules render their own results but never touch the viewer, the legend or
 * the globals above. Everything they want to happen goes through here, so there
 * is one code path that colours the model no matter which check asked.
 */
const shellActions = {
  showInModel(groups, title, subtitle = '') {
    const usable = (groups || []).filter((g) => g.elements && g.elements.length);
    if (!usable.length) {
      toast('Those elements are not in the loaded models.');
      return;
    }
    legend = usable.map((g) => ({
      label: g.label, colour: g.colour, elements: g.elements, missing: false,
    }));
    selection = null;
    soloIndex = -1;
    // Colouring spaces while spaces are hidden would paint nothing.
    if (usable.some((g) => g.elements.some((e) => e.canonicalEntity === 'IFCSPACE')) && !spacesVisible) {
      setSpacesVisible(true);
    }
    el.legendTitle.innerHTML = `${esc(title)}<small>${esc(subtitle)}</small>`;
    renderLegend();
    applyOverlay();
    renderTree();
  },
  showElement(element) {
    if (element) showElement(element);
  },
  toast(message) {
    toast(message);
  },
  /**
   * Draws survey polygons — a cadastral lot, a site boundary — on the ground
   * plane. Rings arrive in projected metres, and the shell rebuilds the same
   * transform the check used to place them in the scene.
   */
  showSurvey(overlays) {
    if (!viewer || !index) return;
    const transform = buildTransform(index.georef, viewer.coordinationMatrix);
    if (!transform.ok) {
      toast('The model is not georeferenced, so survey outlines cannot be placed.');
      return;
    }
    const ground = viewer.groundLevel();
    viewer.setSurveyOverlays((overlays || []).map((o) => ({
      points: o.ring.map(([E, N]) => transform.svy21ToScene(E, N, 0)),
      colour: o.colour,
      opacity: 0.18,
      elevation: ground,
    })));
    viewer.fitSurvey();
    el.toolSurvey.classList.add('active');
    el.toolSurvey.title = `Clear ${overlays.length} survey outline${overlays.length > 1 ? 's' : ''}`;
  },
};

/** Drops the last run's results. Called whenever the model set changes. */
function clearCheckResults() {
  if (checkAbort) checkAbort.abort();
  checkOutcomes = [];
  el.summary.classList.remove('visible');
  el.issues.innerHTML = '';
  el.btnColourStatus.disabled = true;
  // Survey outlines are placed against a particular model's datum, so they are
  // meaningless once the model set changes.
  if (viewer) {
    viewer.clearSurveyOverlays();
    el.toolSurvey.classList.remove('active');
    el.toolSurvey.title = 'No survey outlines drawn';
  }
  if (el.checkMenu.children.length) renderCheckMenu();
}

/** Restores the previous selection, falling back to every non-experimental check. */
function loadSelection() {
  const ids = new Set(registry.all().filter((c) => !c.experimental).map((c) => c.id));
  try {
    const saved = JSON.parse(localStorage.getItem(SELECTION_KEY) || 'null');
    if (Array.isArray(saved)) {
      const known = saved.filter((id) => registry.byId(id));
      // An empty saved list is a real choice; an unparseable one is not.
      return new Set(known);
    }
  } catch { /* storage blocked or corrupt — fall back to the default */ }
  return ids;
}

function saveSelection() {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify([...selectedChecks]));
  } catch { /* private window or blocked storage; the session still works */ }
}

/** The menu of available checks, grouped by authority. */
function renderCheckMenu() {
  const groups = registry.byAuthority();

  el.checkMenu.innerHTML = groups.map((group) => `
    <div class="cm-group">
      <div class="cm-head">${esc(group.authority)}</div>
      ${group.checks.map((c) => {
        const outcome = checkOutcomes.find((o) => o.id === c.id);
        let chip = '';
        if (outcome && outcome.error) {
          chip = '<span class="cm-chip bad">failed</span>';
        } else if (outcome && outcome.result) {
          const s = outcome.result.summary;
          chip = s.fail
            ? `<span class="cm-chip bad">${s.fail} issue${s.fail > 1 ? 's' : ''}</span>`
            // A check that asserted nothing has not found the model clean — it
            // has not looked at it. Saying "clean" there would be a lie.
            : s.assertions ? '<span class="cm-chip ok">clean</span>'
              : '<span class="cm-chip">nothing checked</span>';
        } else if (registry.stateOf(c.id) === 'loading') {
          chip = '<span class="cm-chip">loading…</span>';
        }
        return `
        <label class="cm-row" data-id="${esc(c.id)}">
          <input type="checkbox"${selectedChecks.has(c.id) ? ' checked' : ''} />
          <span class="cm-text">
            <span class="cm-name">${esc(c.title)}
              ${c.experimental ? '<span class="cm-tag">no rules yet</span>' : ''}
              ${chip}
            </span>
            <small>${esc(c.summary)}</small>
          </span>
        </label>
        ${selectedChecks.has(c.id) ? renderCheckInputs(c) : ''}`;
      }).join('')}
    </div>`).join('');

  el.checkMenu.querySelectorAll('.cm-row > input[type=checkbox]').forEach((box) => {
    box.addEventListener('change', () => {
      const id = box.closest('.cm-row').dataset.id;
      if (box.checked) selectedChecks.add(id);
      else selectedChecks.delete(id);
      saveSelection();
      // Inputs appear and disappear with their check, so the menu is redrawn.
      renderCheckMenu();
    });
  });

  wireCheckInputs();
  updateRunButton();
}

/** The extra inputs a check declares, shown only while that check is selected. */
function renderCheckInputs(check) {
  if (!check.inputs || !check.inputs.length) return '';

  return `<div class="cm-inputs">${check.inputs.map((input) => {
    const key = check.id + '.' + input.id;
    const held = checkInputs.get(key);
    let control;
    if (input.kind === 'custom') {
      // Filled by the input's own module once the menu is in the page.
      control = `<div class="cm-custom" data-custom="${esc(key)}">
           <div class="cm-help">Loading…</div>
         </div>`;
    } else if (input.kind === 'file') {
      control = `<div class="cm-file">
           <button class="btn sm" data-pick="${esc(key)}">Choose file</button>
           <input type="file" data-file="${esc(key)}" accept="${esc(input.accept || '')}" hidden />
           <span class="cm-filename">${held ? esc(held.name) : 'No file chosen'}</span>
           ${held ? `<button class="btn sm" data-clear="${esc(key)}" title="Remove">&times;</button>` : ''}
         </div>`;
    } else if (input.kind === 'select') {
      const current = held === undefined ? input.default : held;
      control = `<select class="cm-select" data-select="${esc(key)}">${
        (input.options || []).map((o) =>
          `<option value="${esc(o.value)}"${o.value === current ? ' selected' : ''}>${esc(o.label)}</option>`
        ).join('')}</select>`;
    } else {
      control = `<input type="text" class="cm-textin" data-text="${esc(key)}"
           placeholder="${esc(input.placeholder || '')}" value="${esc(held || '')}" />`;
    }

    return `<div class="cm-input">
      <div class="cm-input-label">${esc(input.label)}</div>
      ${control}
      ${input.help ? `<div class="cm-help">${esc(input.help)}</div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function wireCheckInputs() {
  el.checkMenu.querySelectorAll('[data-custom]').forEach((host) => {
    const mod = customInputModules.get(host.dataset.custom);
    if (!mod) return;
    Promise.resolve(mod.mount(host, customInputApi)).catch((err) => {
      console.error(err);
      host.innerHTML = '<div class="cm-help">This input could not be shown — see the browser console.</div>';
    });
  });

  el.checkMenu.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.checkMenu.querySelector(`[data-file="${CSS.escape(btn.dataset.pick)}"]`).click();
    });
  });

  el.checkMenu.querySelectorAll('[data-file]').forEach((picker) => {
    picker.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        // Read once, here, so the check receives plain text and never touches
        // the file system itself.
        checkInputs.set(picker.dataset.file, { name: file.name, text: await file.text() });
        renderCheckMenu();
      } catch (err) {
        console.error(err);
        toast(`Could not read ${file.name}.`);
      }
      e.target.value = '';
    });
  });

  el.checkMenu.querySelectorAll('[data-clear]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      checkInputs.delete(btn.dataset.clear);
      renderCheckMenu();
    });
  });

  el.checkMenu.querySelectorAll('[data-text]').forEach((box) => {
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('input', () => {
      const v = box.value.trim();
      if (v) checkInputs.set(box.dataset.text, v);
      else checkInputs.delete(box.dataset.text);
    });
  });

  el.checkMenu.querySelectorAll('[data-select]').forEach((box) => {
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', (e) => {
      e.stopPropagation();
      checkInputs.set(box.dataset.select, box.value);
    });
  });
}

/** Everything the user has supplied for one check, keyed by input id. */
function inputsFor(checkId) {
  const meta = registry.byId(checkId);
  const out = {};
  for (const input of (meta && meta.inputs) || []) {
    if (input.kind === 'custom') {
      const mod = customInputModules.get(checkId + '.' + input.id);
      if (mod) out[input.id] = mod.value();
      continue;
    }
    const held = checkInputs.get(checkId + '.' + input.id);
    // A select the user never touched still has the value the menu is showing.
    if (held !== undefined) out[input.id] = held;
    else if (input.default !== undefined) out[input.id] = input.default;
  }
  return out;
}

function updateRunButton() {
  const n = selectedChecks.size;
  el.btnRunCheck.disabled = !index || n === 0 || checkRunning;
  el.btnRunCheck.textContent = checkRunning
    ? 'Checking…'
    : n === 0 ? 'Select a check'
      : n === 1 ? 'Run 1 check' : `Run ${n} checks`;
}

/** Runs every selected check, in menu order. */
async function doRunCheck() {
  if (!index || !ruleset || !selectedChecks.size || checkRunning) return;

  const ids = registry.all().map((c) => c.id).filter((id) => selectedChecks.has(id));

  if (checkAbort) checkAbort.abort();
  checkAbort = new AbortController();

  checkRunning = true;
  updateRunButton();
  el.issues.innerHTML = '<div class="empty-note">Running…</div>';

  const ctx = {
    index,
    ruleset,
    modelNames: new Map(viewer.entries.map((e) => [e.modelID, e.name])),
    filter: (t) =>
      (!gatewayFilter || t.gateway === gatewayFilter) &&
      appliesToAgency(t, agencyFilter),
    signal: checkAbort.signal,
    progress: () => {},
    inputsFor,
    // The submitted files themselves, for the checks that are about the
    // submission rather than about the building.
    files: viewer.entries.map((e) => ({ modelID: e.modelID, name: e.name, bytes: e.bytes })),
    // Where the model sits, and what it is made of — needed by checks that ask
    // about position rather than properties.
    coordinationMatrix: viewer.coordinationMatrix,
    geometry: {
      // Hulls rather than raw points: the affine transform to survey
      // coordinates preserves convexity, so hulling in scene space first is
      // both exact and far cheaper than transforming millions of vertices.
      elementHull: (elements) => viewer.elementHull(elements),
      modelHull: () => viewer.modelHull(),
      groundLevel: () => viewer.groundLevel(),
    },
  };

  try {
    checkOutcomes = await runChecks(ids, ctx, (msg) => {
      el.issues.innerHTML = `<div class="empty-note">${esc(msg)}</div>`;
    });
    renderSummary();
    renderCheckResults();
    renderCheckMenu();
    el.btnColourStatus.disabled = !checkOutcomes.some((o) => o.result);

    const broken = checkOutcomes.filter((o) => o.error);
    if (broken.length) {
      toast(`${broken.length} check${broken.length > 1 ? 's' : ''} could not run — see the browser console.`);
    }
  } catch (err) {
    console.error(err);
    toast('The compliance check failed — see the browser console.');
  } finally {
    checkRunning = false;
    updateRunButton();
  }
}

/** Headline numbers across every check that ran. */
function renderSummary() {
  const t = totalsOf(checkOutcomes);
  const pct = t.assertions ? Math.round((t.pass / t.assertions) * 100) : 0;
  const scope = [gatewayFilter && GATEWAY_LABEL[gatewayFilter], agencyFilter]
    .filter(Boolean).join(' · ') || 'All gateways';
  const names = checkOutcomes.filter((o) => o.result).map((o) => o.meta.title).join(', ');

  el.summary.classList.add('visible');
  el.summary.innerHTML = `
    <div class="sbar">
      <i style="width:${pct}%;background:var(--ok)"></i>
      <i style="width:${100 - pct}%;background:var(--danger)"></i>
    </div>
    <div class="sgrid">
      <span class="k">Checks run</span><span class="v">${esc(names || 'none')}</span>
      <span class="k">Scope</span><span class="v">${esc(scope)}</span>
      <span class="k">Models</span><span class="v">${viewer.entries.length}</span>
      <span class="k">Elements checked</span><span class="v">${t.elements}</span>
      <span class="k">Assertions</span><span class="v">${t.assertions}</span>
      <span class="k">Compliant</span><span class="v" style="color:var(--ok)">${t.pass} (${pct}%)</span>
      <span class="k">Issues</span><span class="v" style="color:var(--danger)">${t.fail}</span>
    </div>`;
}

/**
 * One section per check. The module renders its own body, so the shell never
 * needs to understand what any particular check found.
 */
function renderCheckResults() {
  el.issues.innerHTML = '';

  if (!checkOutcomes.length) {
    el.issues.innerHTML = '<div class="empty-note">No checks were run.</div>';
    return;
  }

  for (const outcome of checkOutcomes) {
    const section = document.createElement('div');
    section.className = 'check-result';

    const summary = outcome.result ? outcome.result.summary : null;
    const pill = outcome.error
      ? '<span class="pill bad">error</span>'
      : summary && summary.fail ? `<span class="pill bad">${summary.fail}</span>`
        // "Nothing checked" is not "clean": a check with no rules, or one whose
        // rules all fell out of scope, asserted nothing about this model.
        : summary && summary.assertions ? '<span class="pill ok">clean</span>'
          : '<span class="pill">nothing checked</span>';

    section.innerHTML = `
      <div class="cr-head">
        <span class="cr-title">${esc(outcome.meta.title)}
          <small>${esc(outcome.meta.authority)} · ${Math.round(outcome.ms)} ms</small>
        </span>${pill}
      </div>
      ${outcome.result && outcome.result.note
        ? `<div class="cr-note">${esc(outcome.result.note)}</div>` : ''}
      <div class="cr-body"></div>`;

    const body = section.querySelector('.cr-body');

    if (outcome.error) {
      body.innerHTML =
        `<div class="empty-note">This check could not run.<br><code>${esc(outcome.error.message)}</code></div>`;
    } else {
      const module = registry.peek ? registry.peek(outcome.id) : null;
      const renderer = module && typeof module.render === 'function' ? module.render : null;
      if (renderer) renderer(outcome.result, body, shellActions);
      else renderGenericFindings(outcome.result, body);
    }

    el.issues.appendChild(section);
  }
}

/** Fallback results view for a module that does not render its own. */
function renderGenericFindings(result, host) {
  const findings = result.findings || [];
  if (!findings.length) {
    host.innerHTML = '<div class="empty-note">Nothing to report.</div>';
    return;
  }
  host.innerHTML = '<div class="ilist">' + findings.slice(0, 300).map((f) => `
    <div class="irow">
      <span class="status-dot" style="background:${hex(SEVERITY_COLOUR[f.severity] || SEVERITY_COLOUR.fail)}"></span>
      <span class="ik">${esc(f.label || f.code)}<br>
        <span style="color:var(--text-dim);font-size:10.5px">${esc(f.message || '')}</span></span>
    </div>`).join('') + '</div>';
}

/**
 * Colours every checked element by its worst severity across every check that
 * ran, so one view answers "where are the problems" regardless of which check
 * found them.
 */
function colourByStatus() {
  if (!checkOutcomes.length) return;

  const worst = new Map();   // element key -> severity

  for (const outcome of checkOutcomes) {
    if (!outcome.result) continue;
    for (const key of outcome.result.summary.elementKeys || []) {
      if (!worst.has(key)) worst.set(key, SEVERITY.PASS);
    }
    for (const f of outcome.result.findings || []) {
      if (!f.element) continue;
      const current = worst.get(f.element.key) || SEVERITY.PASS;
      worst.set(f.element.key, worstOf([current, f.severity]));
    }
  }

  if (!worst.size) {
    toast('No elements were checked, so there is nothing to colour.');
    return;
  }

  const buckets = new Map();
  for (const [key, severity] of worst) {
    if (!buckets.has(severity)) buckets.set(severity, []);
    const element = index.byId.get(key);
    if (element) buckets.get(severity).push(element);
  }

  const groups = SEVERITY_ORDER
    .filter((s) => buckets.has(s) && buckets.get(s).length)
    .map((s) => ({
      label: SEVERITY_LABEL[s],
      colour: SEVERITY_COLOUR[s],
      elements: buckets.get(s),
    }));

  shellActions.showInModel(groups, 'Compliance status',
    `${worst.size} elements across ${checkOutcomes.filter((o) => o.result).length} checks`);
}

// ----------------------------------------------------------------- dashboard

let dashResult = null;

function openDashboard() {
  if (!index) {
    toast('Load an IFC model first.');
    return;
  }
  const names = new Map(viewer.entries.map((e) => [e.modelID, e.name]));
  dashResult = computeDashboard(index, names);
  el.dashSub.textContent =
    `${viewer.entries.length} model${viewer.entries.length > 1 ? 's' : ''} · ` +
    `${index.count.toLocaleString()} indexed elements · ` +
    `${dashResult.summary.present} of ${dashResult.summary.total} metrics found`;
  renderDashboard();
  el.dash.classList.add('visible');
}

function renderDashboard() {
  if (!dashResult) return;
  const { metrics, summary } = dashResult;
  const parts = [];

  // Compliance: anything the federated model does not contain at all.
  if (summary.missing.length) {
    parts.push(`
      <div class="dash-alert">
        <b>Not present in the federated model —</b> ${summary.missing.length} of
        ${summary.total} reported quantities have no matching elements.
        <ul>${summary.missing.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
      </div>`);
  }
  if (summary.incomplete.length) {
    parts.push(`
      <div class="dash-alert warn">
        <b>Elements found but no value authored —</b> these totals understate the real figure.
        <ul>${summary.incomplete.map((m) =>
          `<li>${esc(m.title)}: ${m.missing} of ${m.of} elements have no value</li>`).join('')}</ul>
      </div>`);
  }

  parts.push('<div class="cards">');
  for (const m of metrics) {
    const rows = dashBreakdown === 'file' ? m.byFile : dashBreakdown === 'level' ? m.byLevel : [];
    const brkTitle = dashBreakdown === 'file' ? 'BY FILE' : 'BY LEVEL';

    const flag = !m.present
      ? '<span class="flag">Not found</span>'
      : m.missingValue
        ? `<span class="flag partial">${m.missingValue} without value</span>`
        : '<span class="flag ok">OK</span>';

    parts.push(`<div class="card${m.present ? '' : ' absent'}" data-m="${esc(m.id)}">
      <div class="card-head">
        <div class="ct"><h3>${esc(m.title)}</h3>${flag}</div>
        <div class="card-val${m.present ? '' : ' none'}">${
          m.present ? esc(fmtNum(m.total, m.decimals)) : '—'
        }<small>${esc(m.unit)}</small></div>
        <div class="card-meta">${
          m.present
            ? `${m.count} element${m.count > 1 ? 's' : ''}` +
              (m.whereLabel ? ` · ${esc(m.whereLabel)}` : '') +
              (m.candidates > m.count ? ` · ${m.candidates - m.count} excluded by filter` : '')
            : 'no matching elements'
        }</div>
      </div>`);

    if (!m.present) {
      parts.push('<div class="card-empty">');
      if (m.nearMisses.length) {
        // The elements exist but are typed differently — that is a finding, not
        // an absence, and the distinction changes what the architect does next.
        parts.push(`Nothing matches the mapping's subtype, but similarly named
          elements are present. They would not be found by the authority's query:
          <table class="brk" style="margin-top:6px">${m.nearMisses.map((n) =>
            `<tr><td class="k">${esc(n.label)}</td><td class="c">${n.count}</td></tr>`).join('')}</table>`);
      } else {
        parts.push(`Nothing in the loaded models matches this definition. Either the
          elements are not modelled, or their ObjectType is not set as the mapping requires.`);
      }
      parts.push('</div>');
    } else {
      parts.push('<div class="card-body">');

      if (m.subtotals && m.subtotals.length) {
        parts.push(`<div class="brk-title">OF WHICH</div><table class="brk">`);
        for (const s of m.subtotals) {
          parts.push(`<tr><td class="k">${esc(s.label)}</td>
            <td class="n">${esc(fmtNum(s.value, m.decimals))} ${esc(m.unit)}</td>
            <td class="c">${s.count}</td></tr>`);
        }
        parts.push('</table>');
      }

      if (m.byType.length > 1 || (m.byType.length === 1 && m.isCount)) {
        parts.push(`<div class="brk-title">BY TYPE</div><table class="brk">`);
        for (const r of m.byType) {
          parts.push(`<tr><td class="k">${esc(r.label)}</td>
            <td class="n">${esc(fmtNum(r.value, m.decimals))}${m.isCount ? '' : ' ' + esc(m.unit)}</td>
            <td class="c">${m.isCount ? '' : r.count}</td></tr>`);
        }
        parts.push('</table>');
      }

      if (rows.length) {
        parts.push(`<div class="brk-title">${brkTitle}</div><table class="brk">`);
        for (const r of rows) {
          parts.push(`<tr><td class="k">${esc(r.label)}</td>
            <td class="n">${esc(fmtNum(r.value, m.decimals))}${m.isCount ? '' : ' ' + esc(m.unit)}</td>
            <td class="c">${m.isCount ? '' : r.count}</td></tr>`);
        }
        parts.push('</table>');
      }
      parts.push('</div>');
      parts.push(`<div class="card-actions">
        <button class="btn sm" data-act="show">Show in model</button></div>`);
    }

    const srcBits = [m.source];
    if (m.valueSources.length) srcBits.push(`Value read from ${m.valueSources.join(', ')}`);
    if (m.note) srcBits.push(m.note);
    parts.push(`<div class="card-src">${srcBits.map(esc).join('<br>')}</div></div>`);
  }
  parts.push('</div>');

  el.dashBody.innerHTML = parts.join('');

  el.dashBody.querySelectorAll('[data-act="show"]').forEach((b) => {
    b.addEventListener('click', () => {
      const m = metrics.find((x) => x.id === b.closest('.card').dataset.m);
      if (m) showMetricInModel(m);
    });
  });
}

/** Colours a metric's elements in the 3D view and closes the overlay. */
function showMetricInModel(metric) {
  // Colour per lot/bin type where the metric has one, otherwise a single bucket.
  const byType = metric.byType.filter((t) => t.elements.length);
  legend = byType.length > 1
    ? byType.map((t, i) => ({
        label: t.label,
        colour: PALETTE[i % PALETTE.length],
        elements: t.elements,
        missing: false,
      }))
    : [{ label: metric.title, colour: SINGLE_COLOUR, elements: metric.elements, missing: false }];

  selection = null;
  soloIndex = -1;
  if (metric.entity === 'IFCSPACE' && !spacesVisible) setSpacesVisible(true);
  el.legendTitle.innerHTML =
    `${esc(metric.title)}<small>${metric.count} elements · ${esc(fmtNum(metric.total, metric.decimals))} ${esc(metric.unit)}</small>`;
  renderLegend();
  applyOverlay();
  el.dash.classList.remove('visible');
}

// ------------------------------------------------------------- element inspector

/**
 * The indexed element a pick lands on. A geometry-less aggregate (a stair) can
 * never be hit directly, so a hit on one of its parts resolves to the host when
 * the part is not itself mapped (a stringer), and to the part when it is (a
 * flight, which has requirements of its own and links back to its host).
 */
function pickedElement(hit) {
  if (!hit || !index) return null;
  const key = `${hit.modelID}:${hit.expressID}`;
  const item = index.byId.get(key);
  if (item) return item;
  const hostKey = index.hostOf.get(key);
  return hostKey ? index.byId.get(hostKey) || null : null;
}

function onPick(hit) {
  // A section drag ends with a click on the same element; while armed, that
  // click is drawing intent, not a pick.
  if (sectionArmed) return;
  if (!hit || !index) {
    el.panel.classList.remove('visible');
    return;
  }
  const item = pickedElement(hit);
  if (!item) {
    el.panelBody.innerHTML =
      `<div class="prop-type">Element ${hit.expressID}</div>
       <div class="prop-id">Not covered by the IFC-SG mapping</div>`;
    el.panel.classList.add('visible');
    return;
  }
  showElement(item);
}

function showElement(item) {
  const modelName = viewer.models.get(item.modelID)?.name;
  const rows = [
    ['Entity', item.entity],
    ['PredefinedType', item.predefinedType],
    ['ObjectType', item.objectType],
    ['Storey', item.storey],
    ['Model', viewer.entries.length > 1 ? modelName : null],
    ['Tag', item.tag],
    ['GlobalId', item.globalId],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');

  let html = `<div class="prop-type">${esc(item.name || item.entity)}</div>
              <div class="prop-id">Express ID ${item.expressID}</div>`;
  html += rows.map(([k, v]) =>
    `<div class="prop-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');

  // A flight is picked, but the FireExit the authority asks about sits on the
  // stair that aggregates it. Link the two so neither reads as missing.
  const host = item.hostKey ? index.byId.get(item.hostKey) : null;
  if (host) {
    html += `<div class="prop-row"><span class="k">Part of</span>
             <span class="v"><a href="#" data-host="${esc(host.key)}">${esc(host.name || host.entity)}</a>
             <small>${esc(host.entity)}</small></span></div>`;
  }
  if (item.parts && item.parts.length) {
    const n = item.parts.length;
    html += `<div class="prop-row"><span class="k">Geometry</span>
             <span class="v">${n} aggregated part${n === 1 ? '' : 's'}</span></div>`;
  }

  // Live pass/fail from every loaded check that can explain one element. This is
  // evaluated on demand, so it is correct whether or not a check has been run,
  // and a check the user has never loaded simply contributes nothing.
  if (ruleset) {
    const ctx = { index, ruleset, modelNames: new Map(), filter: () => true };

    for (const { meta, module } of registry.loadedModules()) {
      if (typeof module.explain !== 'function') continue;

      let findings = [];
      try {
        findings = module.explain(item, ctx) || [];
      } catch (err) {
        console.error(`The ${meta.title} check could not explain this element:`, err);
        continue;
      }

      html += `<div class="sec-head">${esc(meta.title.toUpperCase())}</div>`;
      if (!findings.length) {
        html += `<div style="color:var(--text-dim);font-size:12px">
                   No requirements for this entity and subtype.</div>`;
        continue;
      }

      let rule = null;
      for (const f of findings) {
        if (f.rule && f.rule !== rule) {
          rule = f.rule;
          html += `<div class="pset-name">${esc(rule)}</div>`;
        }
        const colour = hex(f.colour !== undefined ? f.colour : SEVERITY_COLOUR[f.severity]);
        const detail = f.severity === SEVERITY.PASS ? '' : ' — ' + esc(f.label);
        html += `
          <div class="chk-row">
            <span class="status-dot" style="background:${colour}" title="${esc(f.label)}"></span>
            <span class="ck">${esc(f.message || f.label)}<small>${detail}</small></span>
            <span class="cv">${esc(f.value === undefined ? '' : f.value)}</span>
          </div>`;
      }
    }
  }

  // Everything actually present on the element, for cross-checking.
  const psetNames = Object.keys(item.psets).sort();
  if (psetNames.length) {
    html += `<div class="sec-head">PROPERTY SETS IN MODEL</div>`;
    for (const pn of psetNames) {
      html += `<div class="pset-name">${esc(pn)}</div>`;
      for (const [k, v] of Object.entries(item.psets[pn])) {
        html += `<div class="prop-row"><span class="k">${esc(k)}</span>
                 <span class="v">${esc(isEmptyValue(v) ? '—' : formatValue(v))}</span></div>`;
      }
    }
  }

  el.panelBody.innerHTML = html;
  el.panel.classList.add('visible');

  const hostLink = el.panelBody.querySelector('a[data-host]');
  if (hostLink) {
    hostLink.addEventListener('click', (e) => {
      e.preventDefault();
      const target = index && index.byId.get(hostLink.dataset.host);
      if (target) showElement(target);
    });
  }
}

// ------------------------------------------------- Microsoft Teams (no-op outside)

(function initTeams() {
  const script = document.createElement('script');
  script.src = 'https://res.cdn.office.net/teams-js/2.19.0/js/MicrosoftTeams.min.js';
  script.onload = () => {
    try {
      window.microsoftTeams.app.initialize()
        .then(() => window.microsoftTeams.app.notifySuccess())
        .catch(() => {});
    } catch { /* not running inside Teams */ }
  };
  document.head.appendChild(script);
})();

init();
