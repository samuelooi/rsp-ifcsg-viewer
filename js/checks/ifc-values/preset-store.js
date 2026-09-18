/**
 * Where value presets live: data/value-presets.json, shared through git.
 *
 * tools/serve.ps1 exposes that file at /api/presets for reading and writing.
 * On a plain static host there is no API, so the file is read directly and
 * the presets are read-only — they still run, they just cannot be edited.
 */

import { normalisePreset, presetEntity } from './presets.js';

const API_URL = 'api/presets';
const STATIC_URL = 'data/value-presets.json';

/** @type {import('./presets.js').ValuePreset[]} */
let presets = [];
let writable = false;
let loading = null;
const listeners = new Set();

function parse(doc) {
  const list = doc && Array.isArray(doc.presets) ? doc.presets : [];
  return list.map(normalisePreset);
}

/**
 * Loads the shared presets once per session. Safe to call repeatedly.
 * @returns {Promise<import('./presets.js').ValuePreset[]>}
 */
export function loadPresets() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const res = await fetch(API_URL, { cache: 'no-cache' });
      if (res.ok) {
        presets = parse(await res.json());
        writable = true;
        return presets;
      }
    } catch { /* no API on this host */ }

    try {
      const res = await fetch(STATIC_URL, { cache: 'no-cache' });
      if (res.ok) presets = parse(await res.json());
    } catch { /* no presets file yet */ }
    writable = false;
    return presets;
  })();
  return loading;
}

/** The presets as last loaded or saved. */
export function currentPresets() {
  return presets;
}

/** The ones the IFC values check should run. */
export function enabledPresets() {
  return presets.filter((p) => p.enabled);
}

/** False when the page is not served by tools/serve.ps1, so saving would fail. */
export function canSave() {
  return writable;
}

/** Upper-case entities the presets select, so the model indexer keeps them. */
export function presetEntities() {
  return [...new Set(presets.map(presetEntity).filter(Boolean))];
}

/** Called with the new list whenever it changes. Returns an unsubscribe function. */
export function onPresetsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Replaces the whole list on the server. The file is small and edited by one
 * person at a time, so sending all of it keeps the server trivially simple.
 * @throws {Error} when the server refuses or is not there.
 */
export async function savePresets(list) {
  if (!writable) {
    throw new Error('Saving needs the app to be served by tools/serve.ps1.');
  }
  const next = list.map(normalisePreset);
  const body = JSON.stringify({ version: 1, presets: next }, null, 2) + '\n';
  const res = await fetch(API_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const reason = await res.text().catch(() => '');
    throw new Error(`The server did not save the presets (${res.status}${reason ? ': ' + reason : ''}).`);
  }
  presets = next;
  for (const fn of listeners) fn(presets);
  return presets;
}
