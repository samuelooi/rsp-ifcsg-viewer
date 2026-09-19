/**
 * Project settings: what is being submitted, to whom, at which gateway — and
 * everything the compliance run needs that is not in the model.
 *
 * A project is a plain JSON file the user keeps next to the IFC set. It holds
 * the submission context (gateway, authorities in scope), the checks to run,
 * every input those checks were given (the cadastral lot is embedded as text,
 * so the file is self-contained and survives being emailed), and which shared
 * value presets are ticked. Nothing about the session — hidden elements,
 * section cuts, colours, results — belongs in it.
 *
 * This module owns the schema, validation, (de)serialisation and the disk and
 * browser storage. Applying a project to the app's state is app.js's job, since
 * that is where the state lives.
 */

export const FORMAT = 'rsp-ifcsg-project';

/**
 * 1 — identity, submission scope, check selection and inputs.
 * 2 — adds `models`: a record per model of what was checked and what came out,
 *     so a federated submission can be checked one file at a time and the
 *     results still add up. A version 1 file still loads; its `project.files`
 *     name list becomes records with no identity.
 */
export const VERSION = 2;

const RECENT_KEY = 'rsp-ifcsg.project.recent';
const LAST_KEY = 'rsp-ifcsg.project.last';
const RECENT_MAX = 5;

/** A project with nothing filled in. */
export function emptyProject() {
  return {
    format: FORMAT,
    version: VERSION,
    project: { code: '', name: '', developer: '', lots: [], files: [] },
    submission: { gateway: 'construction', authorities: [] },
    checks: { selected: null, inputs: {}, presets: null },
    /**
     * One record per model that has been checked, keyed by the model's own
     * content rather than its file name (see model-id.js). Holds the dashboard
     * quantities, the per-check results and the findings, so the numbers for a
     * whole submission can be assembled without every file being open at once.
     */
    models: [],
    ruleset: { generated: null },
    /** file name -> log of hand edits made to that IFC in the viewer (informational). */
    edits: {},
    saved: null,
  };
}

const str = (v) => (v == null ? '' : String(v).trim());
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

/**
 * Validates and normalises a parsed document. Missing sections fall back to
 * their defaults, so a hand-edited or older file still loads.
 * @throws {Error} when the document is not a project file at all.
 */
export function normaliseProject(doc) {
  if (!doc || typeof doc !== 'object' || doc.format !== FORMAT) {
    throw new Error('Not an IFC-SG project file.');
  }
  if (Number(doc.version) > VERSION) {
    throw new Error(`This project was saved by a newer version of the viewer (format ${doc.version}).`);
  }
  const p = emptyProject();
  const src = doc.project || {};
  p.project = {
    code: str(src.code),
    name: str(src.name),
    developer: str(src.developer),
    lots: strList(src.lots),
    files: strList(src.files),
  };
  const sub = doc.submission || {};
  p.submission = {
    gateway: sub.gateway === 'design' ? 'design' : 'construction',
    authorities: strList(sub.authorities).map((a) => a.toUpperCase()),
  };
  const chk = doc.checks || {};
  p.checks = {
    selected: Array.isArray(chk.selected) ? strList(chk.selected) : null,
    inputs: {},
    presets: Array.isArray(chk.presets) ? strList(chk.presets) : null,
  };
  for (const [key, value] of Object.entries(chk.inputs || {})) {
    if (typeof value === 'string') {
      if (value.trim()) p.checks.inputs[key] = value;
    } else if (value && typeof value === 'object' && typeof value.text === 'string') {
      p.checks.inputs[key] = { name: str(value.name) || 'file', text: value.text };
    }
  }
  p.models = normaliseModels(doc, p);
  p.ruleset = { generated: str(doc.ruleset && doc.ruleset.generated) || null };
  p.edits = doc.edits && typeof doc.edits === 'object' && !Array.isArray(doc.edits) ? doc.edits : {};
  p.saved = str(doc.saved) || null;
  return p;
}

const numOrNull = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/**
 * Model records, tolerant of anything missing. A version 1 file has no
 * records, so its `project.files` list becomes name-only entries: they still
 * show in the panel as expected files, they simply cannot be matched by
 * content until that model is checked again.
 */
function normaliseModels(doc, p) {
  const raw = Array.isArray(doc.models) ? doc.models : null;
  if (!raw) {
    return p.project.files.map((name, i) => ({
      id: 'm' + (i + 1), name, identity: null, checkedAt: null, rulesetGenerated: null,
      elements: 0, storeys: [], georef: null, dashboard: [], checks: [], findings: [],
      findingsTruncated: 0, legacy: true,
    }));
  }
  return raw.filter(Boolean).map((m, i) => ({
    id: str(m.id) || 'm' + (i + 1),
    name: str(m.name),
    identity: m.identity && typeof m.identity === 'object' ? {
      sketch: Array.isArray(m.identity.sketch)
        ? m.identity.sketch.map(Number).filter(Number.isFinite) : [],
      projectGuid: str(m.identity.projectGuid) || null,
      siteGuids: strList(m.identity.siteGuids),
      buildingGuids: strList(m.identity.buildingGuids),
      storeyGuids: strList(m.identity.storeyGuids),
      contentGuid: str(m.identity.contentGuid) || null,
      versionGuid: str(m.identity.versionGuid) || null,
      saves: numOrNull(m.identity.saves),
      headerName: str(m.identity.headerName) || null,
      exportedAt: str(m.identity.exportedAt) || null,
      authoringTool: str(m.identity.authoringTool) || null,
      schema: str(m.identity.schema) || null,
      bytes: numOrNull(m.identity.bytes) || 0,
      elements: numOrNull(m.identity.elements) || 0,
      storeyCount: numOrNull(m.identity.storeyCount) || 0,
    } : null,
    checkedAt: str(m.checkedAt) || null,
    rulesetGenerated: str(m.rulesetGenerated) || null,
    elements: numOrNull(m.elements) || 0,
    storeys: Array.isArray(m.storeys) ? m.storeys.map((s) => ({
      name: str(s.name), elevation: numOrNull(s.elevation), globalId: str(s.globalId) || null,
    })) : [],
    georef: m.georef && typeof m.georef === 'object' ? m.georef : null,
    dashboard: Array.isArray(m.dashboard) ? m.dashboard : [],
    checks: Array.isArray(m.checks) ? m.checks : [],
    findings: Array.isArray(m.findings) ? m.findings : [],
    findingsTruncated: numOrNull(m.findingsTruncated) || 0,
    legacy: false,
  }));
}

/** Parses file text into a project. */
export function parseProject(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  return normaliseProject(doc);
}

/** True when a dropped or chosen file might be a project, by name alone. */
export function looksLikeProjectFile(name) {
  return /\.json$/i.test(name || '');
}

/** The file text, stable key order, ready to write. */
export function serialise(project) {
  return JSON.stringify(project, null, 2) + '\n';
}

/**
 * What "unchanged since saved" compares: everything but the save stamp.
 * Cheap enough to call on every UI redraw.
 */
export function fingerprint(project) {
  return JSON.stringify({ ...project, saved: null });
}

/** A display label for chips and lists. */
export function labelOf(project) {
  const { code, name } = project.project;
  return [code, name].filter(Boolean).join(' · ') || 'Untitled project';
}

/** The file name a save suggests. */
export function suggestedFileName(project) {
  const base = (project.project.code || project.project.name || 'project')
    .replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `${base}.ifcsg-project.json`;
}

// ------------------------------------------------------------------------ disk

const PICKER_TYPES = [{
  description: 'IFC-SG project',
  accept: { 'application/json': ['.json'] },
}];

/**
 * Writes the project to disk. In Chrome and Edge the user picks a location
 * once and later saves overwrite it through the returned handle; elsewhere the
 * browser downloads the file. Must be called from a user gesture, since the
 * picker refuses otherwise.
 * @param {object} project
 * @param {FileSystemFileHandle|null} handle  from a previous save or open
 * @param {boolean} forcePicker  "Save as…"
 * @returns {Promise<{handle: FileSystemFileHandle|null, name: string}>}
 */
export async function saveToDisk(project, handle = null, forcePicker = false) {
  const text = serialise(project);
  const name = suggestedFileName(project);

  if (typeof window.showSaveFilePicker === 'function') {
    let h = forcePicker ? null : handle;
    if (!h) {
      h = await window.showSaveFilePicker({ suggestedName: name, types: PICKER_TYPES });
    }
    const writable = await h.createWritable();
    await writable.write(text);
    await writable.close();
    return { handle: h, name: h.name };
  }

  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { handle: null, name };
}

/**
 * Opens a project from disk through the native picker where it exists, or a
 * plain file input elsewhere. Resolves null when the user cancels.
 * @returns {Promise<{project: object, handle: FileSystemFileHandle|null, name: string}|null>}
 */
export async function openFromDisk() {
  if (typeof window.showOpenFilePicker === 'function') {
    let handles;
    try {
      handles = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      throw err;
    }
    const file = await handles[0].getFile();
    return { project: parseProject(await file.text()), handle: handles[0], name: file.name };
  }

  const file = await new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => resolve(input.files[0] || null));
    // A cancelled picker never fires change; nothing to clean up either way.
    input.click();
  });
  if (!file) return null;
  return { project: parseProject(await file.text()), handle: null, name: file.name };
}

// --------------------------------------------------------------------- browser

/**
 * Recently used projects, newest first, each with its full document so the
 * viewer can restore one without a file picker. Capped, and silently skipped
 * when storage is blocked or full — the file on disk is the real copy.
 */
export function recentProjects() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter((r) => r && r.project) : [];
  } catch {
    return [];
  }
}

function recentKey(project) {
  return (project.project.code || '') + ' ' + (project.project.name || '');
}

/**
 * The copy kept in browser storage. Findings are the bulk of a project file
 * and browser storage is a few megabytes in total, so the recent list keeps
 * the counts and drops the findings; the file on disk remains the full record.
 */
function forStorage(project) {
  return {
    ...project,
    models: (project.models || []).map((m) => ({
      ...m,
      findings: [],
      findingsTruncated: (m.findingsTruncated || 0) + (m.findings ? m.findings.length : 0),
    })),
  };
}

/** Puts a project at the top of the recent list and marks it as the last used. */
export function rememberProject(project) {
  const key = recentKey(project);
  const entry = { key, label: labelOf(project), saved: project.saved, project: forStorage(project) };
  const list = [entry, ...recentProjects().filter((r) => r.key !== key)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    localStorage.setItem(LAST_KEY, key);
  } catch { /* quota or private window; the file is the record */ }
}

export function forgetRecent(key) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentProjects().filter((r) => r.key !== key)));
    if (localStorage.getItem(LAST_KEY) === key) localStorage.removeItem(LAST_KEY);
  } catch { /* nothing to forget */ }
}

/** The project the viewer had open last time, or null. */
export function lastProject() {
  try {
    const key = localStorage.getItem(LAST_KEY);
    if (!key) return null;
    const hit = recentProjects().find((r) => r.key === key);
    return hit ? normaliseProject(hit.project) : null;
  } catch {
    return null;
  }
}

export function clearLastProject() {
  try {
    localStorage.removeItem(LAST_KEY);
  } catch { /* nothing to clear */ }
}
