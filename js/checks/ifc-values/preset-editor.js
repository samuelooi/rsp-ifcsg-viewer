/**
 * The value-preset editor, shown under the IFC values check in the check menu.
 *
 * It is a custom check input (see types.js): the shell mounts it into a host
 * element and asks it for its value when the check runs. Everything it offers
 * is read from the loaded model — entities, subtypes, property sets, and the
 * values actually present — and "Show in 3D" colours what a query picks out, so
 * the user can see it has selected the right elements before saving it.
 */

import {
  OPS, RESULT, RESULT_LABEL, RESULT_COLOUR,
  normalisePreset, validatePreset, newId, presetEntity, describePreset,
  selectPresetElements, runPreset, psetCatalog, distinctValues, subtypeCatalog,
} from './presets.js';
import {
  loadPresets, currentPresets, enabledPresets, savePresets, canSave, presetEntities,
} from './preset-store.js';
import { esc } from '../../util/dom.js';

const VALUE_PALETTE = [
  0x4fa3d1, 0xe0a458, 0x77b255, 0xc06c84, 0x6c8ebf, 0xd68f5e,
  0x8fbf6c, 0xa384c4, 0x5fb3a3, 0xd4785e, 0x7f9cd1, 0xbfa76c,
];
const MISSING_COLOUR = 0xd16a4f;

/** How many distinct values to offer as chips before summarising the rest. */
const MAX_CHIPS = 24;

/**
 * Survives the shell redrawing the menu, which it does whenever a check is
 * ticked or a model is loaded, so a half-written preset is not lost.
 * @type {import('./presets.js').ValuePreset|null}
 */
let draft = null;
let draftIsNew = false;
let busy = false;

/**
 * @typedef {object} EditorApi  What the shell lends the editor.
 * @property {() => object|null} index              Merged model index, or null.
 * @property {(canon: string) => boolean} isIndexed  Whether the indexer collects an entity.
 * @property {(canon: string) => void} requireEntity Asks the indexer to collect it from the next load.
 * @property {(groups: object[], title: string, subtitle?: string) => void} showInModel
 * @property {(message: string) => void} toast
 */

/** Entities the presets need, so they are indexed before any model loads. */
export async function requiredEntities() {
  await loadPresets();
  return presetEntities();
}

/** What the IFC values check receives as its `presets` input. */
export function value() {
  return enabledPresets();
}

/**
 * Renders into `host`. Called again on every menu redraw.
 * @param {HTMLElement} host
 * @param {EditorApi} api
 */
export async function mount(host, api) {
  host.innerHTML = '<div class="cm-help">Loading presets…</div>';
  await loadPresets();
  if (!host.isConnected) return;
  render(host, api);
}

// --------------------------------------------------------------------- list

function render(host, api) {
  const presets = currentPresets();
  const writable = canSave();
  const index = api.index();

  host.innerHTML = `
    <div class="vp">
      ${presets.length ? `<div class="vp-list">${presets.map((p) => {
        const n = index ? selectPresetElements(index, p).length : null;
        return `
        <div class="vp-row${draft && draft.id === p.id ? ' editing' : ''}" data-id="${esc(p.id)}">
          <input type="checkbox" data-act="toggle" title="Run with the IFC values check"
            ${p.enabled ? 'checked' : ''} ${writable ? '' : 'disabled'} />
          <span class="vp-text">
            <span class="vp-name">${esc(p.name)}${n === null ? '' : ` <span class="cm-chip">${n}</span>`}</span>
            <small>${esc(describePreset(p))}</small>
          </span>
          <button class="btn sm" data-act="show" title="Show what this preset selects"
            ${index ? '' : 'disabled'}>3D</button>
          <button class="btn sm" data-act="edit" ${writable ? '' : 'disabled'}>Edit</button>
        </div>`;
      }).join('')}</div>` : '<div class="cm-help">No value presets yet.</div>'}
      ${writable ? '' : `<div class="cm-help vp-warn">Read-only: saving presets needs the app
        to be served by <code>tools/serve.ps1</code>.</div>`}
      ${draft ? formHtml(api) : (writable
        ? '<button class="btn sm vp-new" data-act="new">+ New preset</button>' : '')}
    </div>`;

  wire(host, api);
  if (draft) refreshHints(host, api);
}

function wire(host, api) {
  host.querySelector('[data-act="new"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    draft = normalisePreset({ id: newId(), op: 'equals', enabled: true });
    draftIsNew = true;
    render(host, api);
    host.querySelector('[data-f="name"]')?.focus();
  });

  host.querySelectorAll('.vp-row').forEach((row) => {
    const preset = currentPresets().find((p) => p.id === row.dataset.id);
    if (!preset) return;

    row.querySelector('[data-act="toggle"]').addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      const list = currentPresets().map((p) => (p.id === preset.id ? { ...p, enabled } : p));
      await persist(host, api, list, null);
    });

    row.querySelector('[data-act="show"]').addEventListener('click', (e) => {
      e.preventDefault();
      showPassFail(api, preset);
    });

    row.querySelector('[data-act="edit"]').addEventListener('click', (e) => {
      e.preventDefault();
      draft = { ...preset };
      draftIsNew = false;
      render(host, api);
    });
  });

  if (draft) wireForm(host, api);
}

async function persist(host, api, list, successMessage) {
  if (busy) return false;
  busy = true;
  try {
    await savePresets(list);
    // A new entity is only collected from the next model load onwards.
    for (const canon of presetEntities()) api.requireEntity(canon);
    if (successMessage) api.toast(successMessage);
    return true;
  } catch (err) {
    console.error(err);
    api.toast(err.message);
    return false;
  } finally {
    busy = false;
    render(host, api);
  }
}

// --------------------------------------------------------------------- form

function formHtml(api) {
  const d = draft;
  const index = api.index();
  const entities = index
    ? [...index.byEntity.entries()]
      .filter(([, els]) => els.length)
      .map(([, els]) => ({ name: els[0].entity, count: els.length }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return `
    <div class="vp-form">
      <div class="vp-title">${draftIsNew ? 'New preset' : 'Edit preset'}</div>
      <label class="vp-field"><span>Name</span>
        <input class="cm-textin" data-f="name" value="${esc(d.name)}" placeholder="e.g. Fire doors rated 60 min" />
      </label>
      <div class="vp-pair">
        <label class="vp-field"><span>IFC entity</span>
          <input class="cm-textin" data-f="entity" list="vp-entities" value="${esc(d.entity)}" placeholder="IfcDoor" />
        </label>
        <label class="vp-field"><span>Subtype <em>optional</em></span>
          <input class="cm-textin" data-f="subtype" list="vp-subtypes" value="${esc(d.subtype)}" placeholder="any" />
        </label>
      </div>
      <div class="vp-hint" data-h="selection"></div>
      <label class="vp-field"><span>Property set</span>
        <input class="cm-textin" data-f="pset" list="vp-psets" value="${esc(d.pset)}" placeholder="Pset_DoorCommon" />
      </label>
      <label class="vp-field"><span>Property</span>
        <input class="cm-textin" data-f="prop" list="vp-props" value="${esc(d.prop)}" placeholder="FireRating" />
      </label>
      <div class="vp-pair">
        <label class="vp-field vp-op"><span>Condition</span>
          <select class="cm-select" data-f="op">${OPS.map((o) =>
            `<option value="${o.id}"${o.id === d.op ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
          </select>
        </label>
        <label class="vp-field" data-h="value-field"><span>Value</span>
          <input class="cm-textin" data-f="value" list="vp-values" value="${esc(d.value)}" />
        </label>
      </div>
      <div class="vp-hint" data-h="values"></div>
      <div class="vp-error" data-h="error"></div>
      <div class="vp-actions">
        <button class="btn sm" data-act="preview" title="Colour elements that meet and miss the condition">Show in 3D</button>
        <button class="btn sm" data-act="by-value" title="Colour elements by this property's value">By value</button>
        <span class="vp-spacer"></span>
        ${draftIsNew ? '' : '<button class="btn sm vp-danger" data-act="delete">Delete</button>'}
        <button class="btn sm" data-act="cancel">Cancel</button>
        <button class="btn sm primary" data-act="save">Save</button>
      </div>
      <datalist id="vp-entities">${entities.map((e) =>
        `<option value="${esc(e.name)}">${e.count} in model</option>`).join('')}</datalist>
      <datalist id="vp-subtypes"></datalist>
      <datalist id="vp-psets"></datalist>
      <datalist id="vp-props"></datalist>
      <datalist id="vp-values"></datalist>
    </div>`;
}

function readForm(host) {
  const get = (f) => host.querySelector(`[data-f="${f}"]`);
  return normalisePreset({
    ...draft,
    name: get('name').value,
    entity: get('entity').value,
    subtype: get('subtype').value,
    pset: get('pset').value,
    prop: get('prop').value,
    op: get('op').value,
    value: get('value').value,
  });
}

function wireForm(host, api) {
  const form = host.querySelector('.vp-form');

  form.addEventListener('input', () => {
    draft = readForm(host);
    refreshHints(host, api);
  });
  form.addEventListener('change', () => {
    draft = readForm(host);
    refreshHints(host, api);
  });

  form.addEventListener('click', async (e) => {
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      e.preventDefault();
      const input = host.querySelector('[data-f="value"]');
      if (draft.op === 'one-of' && input.value.trim()) {
        const parts = input.value.split(',').map((s) => s.trim()).filter(Boolean);
        if (!parts.includes(chip.dataset.chip)) parts.push(chip.dataset.chip);
        input.value = parts.join(', ');
      } else {
        input.value = chip.dataset.chip;
      }
      draft = readForm(host);
      refreshHints(host, api);
      return;
    }

    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    e.preventDefault();
    draft = readForm(host);

    switch (btn.dataset.act) {
      case 'preview': {
        const problem = validatePreset({ ...draft, name: draft.name || 'preview' });
        if (problem) {
          showError(host, problem);
          return;
        }
        showPassFail(api, draft);
        break;
      }
      case 'by-value':
        showByValue(api, draft);
        break;
      case 'cancel':
        draft = null;
        render(host, api);
        break;
      case 'delete': {
        if (!confirm(`Delete the preset "${draft.name}"?`)) return;
        const id = draft.id;
        const ok = await persist(host, api, currentPresets().filter((p) => p.id !== id), 'Preset deleted.');
        if (ok) {
          draft = null;
          render(host, api);
        }
        break;
      }
      case 'save': {
        const problem = validatePreset(draft);
        if (problem) {
          showError(host, problem);
          return;
        }
        const saved = draft;
        const list = currentPresets().some((p) => p.id === saved.id)
          ? currentPresets().map((p) => (p.id === saved.id ? saved : p))
          : [...currentPresets(), saved];
        const canon = presetEntity(saved);
        const note = api.index() && !api.isIndexed(canon)
          ? ` ${saved.entity} was not read from the loaded model — reload it to include those elements.`
          : '';
        const ok = await persist(host, api, list, `Preset "${saved.name}" saved.${note}`);
        if (ok) {
          draft = null;
          render(host, api);
        }
        break;
      }
      default:
    }
  });
}

function showError(host, message) {
  const box = host.querySelector('[data-h="error"]');
  if (box) box.textContent = message || '';
}

/** Recomputes the suggestions and counts under the form from the loaded model. */
function refreshHints(host, api) {
  const d = draft;
  const index = api.index();
  const sel = host.querySelector('[data-h="selection"]');
  const vals = host.querySelector('[data-h="values"]');
  const op = OPS.find((o) => o.id === d.op);
  host.querySelector('[data-h="value-field"]').style.visibility = op && op.needsValue ? '' : 'hidden';
  showError(host, '');

  const fill = (id, items) => {
    host.querySelector('#' + id).innerHTML = items.map(([v, label]) =>
      `<option value="${esc(v)}">${esc(label)}</option>`).join('');
  };

  if (!index) {
    sel.textContent = 'Load a model to see which elements this selects and what values they carry.';
    vals.textContent = '';
    return;
  }
  if (!d.entity) {
    sel.textContent = 'Choose an entity; the list shows what the loaded model contains.';
    vals.textContent = '';
    return;
  }

  const canon = presetEntity(d);
  fill('vp-subtypes', subtypeCatalog(index, d.entity).map((s) => [s.value, `${s.count}×`]));

  if (!api.isIndexed(canon)) {
    sel.innerHTML = `<span class="vp-warn">${esc(d.entity)} is not read from models yet. Save the
      preset, then reload the model to include it.</span>`;
    vals.textContent = '';
    return;
  }

  const elements = selectPresetElements(index, d);
  sel.textContent = `${elements.length} element${elements.length === 1 ? '' : 's'} selected in the loaded model.`;

  const catalog = psetCatalog(elements);
  fill('vp-psets', catalog.map((c) => [c.pset, `on ${c.count} of ${elements.length}`]));
  const entry = catalog.find((c) => c.pset.toUpperCase() === d.pset.toUpperCase());
  fill('vp-props', entry ? entry.props.map((p) => [p, '']) : []);

  if (!elements.length || !d.pset || !d.prop) {
    vals.textContent = '';
    fill('vp-values', []);
    return;
  }

  const { values, missing } = distinctValues(elements, d.pset, d.prop);
  fill('vp-values', values.map((v) => [v.label, `${v.count}×`]));

  const chips = values.slice(0, MAX_CHIPS).map((v) =>
    `<button class="vp-chip" data-chip="${esc(v.label)}" title="Use this value">${esc(v.label)}
       <b>${v.count}</b></button>`).join('');
  const more = values.length > MAX_CHIPS ? `<span class="vp-more">+${values.length - MAX_CHIPS} more</span>` : '';
  const gap = missing.length ? `<span class="vp-more">${missing.length} without this property</span>` : '';

  let outcome = '';
  if (!validatePreset({ ...d, name: d.name || 'preview' })) {
    const r = runPreset(index, d);
    outcome = `<div class="vp-outcome">
      <span style="color:var(--ok)">${r.byResult[RESULT.PASS].length} meet</span> ·
      <span style="color:var(--danger)">${r.byResult[RESULT.FAIL].length + r.byResult[RESULT.MISSING].length} do not</span>
    </div>`;
  }

  vals.innerHTML = values.length || missing.length
    ? `<div class="vp-values-head">Values in model</div><div class="vp-chips">${chips}${more}${gap}</div>${outcome}`
    : '';
}

// ----------------------------------------------------------------- 3D views

function showPassFail(api, preset) {
  const index = api.index();
  if (!index) {
    api.toast('Load an IFC model first.');
    return;
  }
  const r = runPreset(index, preset);
  if (!r.elements.length) {
    api.toast(`No ${preset.entity}${preset.subtype ? ' [' + preset.subtype + ']' : ''} elements in the loaded model.`);
    return;
  }
  api.showInModel(
    [RESULT.PASS, RESULT.FAIL, RESULT.MISSING].map((code) => ({
      label: RESULT_LABEL[code],
      colour: RESULT_COLOUR[code],
      elements: r.byResult[code],
    })),
    preset.name || 'Preset preview',
    `${describePreset(preset)} · ${r.elements.length} elements`,
  );
}

function showByValue(api, preset) {
  const index = api.index();
  if (!index) {
    api.toast('Load an IFC model first.');
    return;
  }
  if (!preset.entity || !preset.pset || !preset.prop) {
    api.toast('Choose an entity, property set and property first.');
    return;
  }
  const elements = selectPresetElements(index, preset);
  if (!elements.length) {
    api.toast(`No ${preset.entity} elements in the loaded model.`);
    return;
  }
  const { values, missing } = distinctValues(elements, preset.pset, preset.prop);
  const groups = values.map((v, i) => ({
    label: v.label,
    colour: VALUE_PALETTE[i % VALUE_PALETTE.length],
    elements: v.elements,
  }));
  if (missing.length) groups.push({ label: '(no property)', colour: MISSING_COLOUR, elements: missing });
  api.showInModel(groups, `${preset.pset}.${preset.prop}`,
    `${preset.entity}${preset.subtype ? ' [' + preset.subtype + ']' : ''} · ${elements.length} elements`);
}
