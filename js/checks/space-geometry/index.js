/**
 * Space geometry: every IfcSpace must carry a geometric representation.
 *
 * A room that Revit could not enclose, or an area that was never placed,
 * exports as an IfcSpace with `Representation = $`. It still has a number, a
 * name and properties, so property checks pass over it happily — but the
 * authorities cannot see it, measure it or tag it, and an Area_GFA space
 * without geometry contributes nothing to the GFA computation.
 *
 * This is the one condition the community "IFC Space Geometry Checker"
 * (noddlesskcho.github.io/IFC-Space-Geometry-Checker) tests, folded in as a
 * check so it runs with everything else and lands in the BCF and the report.
 * The report columns follow that tool: number, name, level, predefined type,
 * object type, GUID and the Revit lookup id from the space type's Tag.
 */

import { SEVERITY } from '../severity.js';
import { esc } from '../../util/dom.js';

const CODE = 'space-no-geometry';
const LABEL = 'No geometric representation';
const AREA_GFA = 'AREA_GFA';

const text = (v) => (v === null || v === undefined || String(v).trim() === '' ? '' : String(v).trim());

/** The row the report and the CSV show for one space. */
function describe(el, ctx) {
  const lookup = text(el.typeTag);
  return {
    element: el,
    number: text(el.name) || 'N/A',
    name: text(el.longName) || text(el.description) || 'N/A',
    level: text(el.storey) || 'N/A',
    predefinedType: text(el.predefinedType) || 'N/A',
    objectType: text(el.objectType) || 'N/A',
    guid: text(el.globalId) || 'N/A',
    revitLookupId: /^\d+$/.test(lookup) ? lookup : (lookup ? `Invalid Tag "${lookup}"` : 'Not Found'),
    file: (ctx.modelNames && ctx.modelNames.get(el.modelID)) || '',
  };
}

export function run(ctx) {
  const spaces = ctx.index.byEntity.get('IFCSPACE') || [];
  const rows = spaces
    .filter((el) => el.hasGeometry === false)
    .map((el) => describe(el, ctx))
    .sort((a, b) => [a.level, a.number, a.name, a.objectType, a.guid].join('|')
      .localeCompare([b.level, b.number, b.name, b.objectType, b.guid].join('|'), undefined, { numeric: true }));

  const findings = rows.map((r) => ({
    element: r.element,
    severity: SEVERITY.FAIL,
    code: CODE,
    label: LABEL,
    message: `${r.number} ${r.name} (${r.objectType}) on ${r.level} has no geometry` +
      (r.revitLookupId && /^\d+$/.test(r.revitLookupId) ? `; Revit id ${r.revitLookupId}` : ''),
    rule: r.objectType === AREA_GFA ? 'Space geometry · Area_GFA spaces' : 'Space geometry · Other spaces',
  }));

  const areaGfa = rows.filter((r) => r.objectType === AREA_GFA).length;
  return {
    summary: {
      elements: spaces.length,
      assertions: spaces.length,
      pass: spaces.length - rows.length,
      fail: rows.length,
    },
    findings,
    detail: { rows, areaGfa, other: rows.length - areaGfa, spaceCount: spaces.length },
    note: spaces.length ? undefined : 'No IfcSpace entities were found in the loaded models.',
  };
}

const COLUMNS = [
  ['no', 'No.'], ['number', 'Number'], ['name', 'Name'], ['level', 'Level'],
  ['predefinedType', 'PredefinedType'], ['objectType', 'Object Type'], ['guid', 'GUID'],
  ['revitLookupId', 'Revit Lookup ID'], ['file', 'File'],
];

function csvOf(rows) {
  const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [COLUMNS.map(([, h]) => cell(h)).join(',')];
  rows.forEach((r, i) => {
    lines.push(COLUMNS.map(([k]) => cell(k === 'no' ? i + 1 : r[k])).join(','));
  });
  // A byte-order mark so Excel opens it as UTF-8.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function render(result, host, actions) {
  const { rows, areaGfa, other, spaceCount } = result.detail;
  if (!spaceCount) {
    host.innerHTML = '<div class="empty-note">No IfcSpace entities were found in the loaded models.</div>';
    return;
  }
  const head =
    `<div class="empty-note" style="padding:10px 14px">` +
    `${spaceCount} space${spaceCount === 1 ? '' : 's'} checked · ` +
    (rows.length
      ? `<b style="color:var(--danger)">${rows.length} without geometry</b> (${areaGfa} Area_GFA, ${other} other) · ${spaceCount - rows.length} with a valid representation`
      : `<b style="color:var(--ok)">all carry a geometric representation</b>`) +
    (rows.length ? ` <button class="btn sm" data-csv style="margin-left:8px">Download CSV</button>` : '') +
    `</div>`;

  const table = rows.length ? `
    <div style="overflow:auto;padding:0 6px 10px">
      <table class="sg-table">
        <thead><tr>${COLUMNS.map(([, h]) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0, 500).map((r, i) => `<tr data-i="${i}">${COLUMNS.map(([k]) =>
          `<td>${esc(k === 'no' ? String(i + 1) : r[k])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
      ${rows.length > 500 ? `<div class="empty-note">and ${rows.length - 500} more — the CSV has them all.</div>` : ''}
    </div>` : '';

  host.innerHTML = head + table;

  const csvBtn = host.querySelector('[data-csv]');
  if (csvBtn) {
    csvBtn.addEventListener('click', () => {
      const url = URL.createObjectURL(new Blob([csvOf(rows)], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `space-geometry-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
  }
  // A space with no geometry cannot be coloured, but its properties can be inspected.
  host.querySelectorAll('tr[data-i]').forEach((tr) => {
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => actions.showElement(rows[+tr.dataset.i].element));
  });
}

/** In the inspector: one line for a space, present or missing. */
export function explain(element) {
  if (element.canonicalEntity !== 'IFCSPACE') return [];
  const ok = element.hasGeometry !== false;
  return [{
    element,
    severity: ok ? SEVERITY.PASS : SEVERITY.FAIL,
    code: ok ? 'space-geometry-ok' : CODE,
    label: ok ? 'Geometric representation present' : LABEL,
    message: 'IfcSpace.Representation',
    value: ok ? 'Present' : 'Missing',
    rule: 'Space geometry',
  }];
}

export default { run, render, explain };
