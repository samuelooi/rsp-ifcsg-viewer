/**
 * The submission readiness report: what was checked, what came out, and
 * whether the project is ready to go to the authorities — as a PDF the QP can
 * file with the submission.
 *
 * The content is derived from the check outcomes alone, so every check module
 * present or future reports the same way: its summary counts, its rule-level
 * results where it has them, and its findings by severity. The verdict is
 * deliberately strict: ready means every selected check ran and produced no
 * failure. Warnings are listed but do not block.
 */

import { PdfWriter, A4 } from './pdf.js';

const INK = [34, 38, 44];
const MUTED = [110, 116, 128];
const DIM = [150, 156, 166];
const RULE = [210, 214, 220];
const ZEBRA = [245, 246, 248];
const HEAD = [232, 235, 240];
const GREEN = [60, 130, 70];
const RED = [190, 60, 45];
const AMBER = [190, 130, 30];
const BLUE = [50, 110, 160];

// ------------------------------------------------------------------ layout

/**
 * A top-to-bottom flow over PdfWriter pages: headings, paragraphs, key-value
 * blocks and tables that break across pages with their header repeated.
 */
class Flow {
  constructor(writer, { margin = 46, footer = () => '' } = {}) {
    this.w = writer;
    this.margin = margin;
    this.top = margin;
    this.bottom = writer.height - margin - 14;
    this.width = writer.width - margin * 2;
    this.footer = footer;
    this.y = this.top;
    writer.addPage();
  }

  newPage() {
    this.w.addPage();
    this.y = this.top;
  }

  ensure(h) {
    if (this.y + h > this.bottom) this.newPage();
  }

  space(h = 8) {
    this.y += h;
  }

  /** Splits text into lines that fit `width` at `size`. */
  wrap(text, width, size, bold = false) {
    const lines = [];
    for (const para of String(text == null ? '' : text).split(/\r?\n/)) {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); continue; }
      let line = '';
      for (const word of words) {
        const trial = line ? line + ' ' + word : word;
        if (this.w.textWidth(trial, size, bold) <= width || !line) line = trial;
        else { lines.push(line); line = word; }
      }
      lines.push(line);
    }
    return lines;
  }

  heading(text, { level = 1 } = {}) {
    const size = level === 0 ? 18 : level === 1 ? 13 : 10.5;
    const lead = size * 1.35;
    this.ensure(lead + 12);
    this.y += level === 0 ? 0 : 10;
    this.w.text(this.margin, this.y + size, text, { size, bold: true, color: INK });
    this.y += lead;
    if (level === 1) {
      this.w.line(this.margin, this.y + 1, this.margin + this.width, this.y + 1, { color: RULE, width: 0.6 });
      this.y += 6;
    } else {
      this.y += 2;
    }
  }

  paragraph(text, { size = 9.5, color = INK, bold = false, indent = 0, lead = null } = {}) {
    const lh = lead || size * 1.4;
    for (const line of this.wrap(text, this.width - indent, size, bold)) {
      this.ensure(lh);
      this.w.text(this.margin + indent, this.y + size, line, { size, color, bold });
      this.y += lh;
    }
    this.y += 3;
  }

  /** Two-column label/value rows. */
  keyValues(rows, { labelWidth = 120, size = 9.5 } = {}) {
    for (const [k, v] of rows) {
      if (v === null || v === undefined || v === '') continue;
      const lines = this.wrap(v, this.width - labelWidth, size);
      const lh = size * 1.4;
      this.ensure(lh * lines.length);
      this.w.text(this.margin, this.y + size, k, { size, color: MUTED });
      lines.forEach((line, i) => {
        this.w.text(this.margin + labelWidth, this.y + size + i * lh, line, { size, color: INK });
      });
      this.y += lh * lines.length + 1;
    }
    this.y += 4;
  }

  /** A banner with a bold verdict and a line under it. */
  banner(title, subtitle, colour) {
    const h = 46;
    this.ensure(h + 6);
    this.w.rect(this.margin, this.y, this.width, h, { fill: colour });
    this.w.text(this.margin + 14, this.y + 21, title, { size: 15, bold: true, color: [255, 255, 255] });
    this.w.text(this.margin + 14, this.y + 36, subtitle, { size: 9, color: [255, 255, 255] });
    this.y += h + 10;
  }

  /**
   * A table. Columns: { label, width (pt) or flex, align, color(row) }.
   * Rows are arrays of cell strings; a cell may be { text, color, bold }.
   */
  table(columns, rows, { size = 8.5, zebra = true, note = null } = {}) {
    const fixed = columns.reduce((s, c) => s + (c.width || 0), 0);
    const flexTotal = columns.reduce((s, c) => s + (c.width ? 0 : (c.flex || 1)), 0);
    const flexWidth = Math.max(0, this.width - fixed);
    const widths = columns.map((c) => c.width || (flexWidth * (c.flex || 1)) / flexTotal);
    const pad = 4;
    const lh = size * 1.35;

    const drawHeader = () => {
      const h = lh + pad * 2;
      this.w.rect(this.margin, this.y, this.width, h, { fill: HEAD });
      let x = this.margin;
      columns.forEach((c, i) => {
        const tx = c.align === 'right' ? x + widths[i] - pad : x + pad;
        this.w.text(tx, this.y + pad + size, c.label, { size, bold: true, color: INK, align: c.align === 'right' ? 'right' : 'left' });
        x += widths[i];
      });
      this.y += h;
    };

    this.ensure(lh * 3 + pad * 4);
    drawHeader();
    rows.forEach((row, r) => {
      const cells = row.map((cell, i) => {
        const c = cell && typeof cell === 'object' ? cell : { text: cell };
        return { ...c, lines: this.wrap(c.text == null ? '' : String(c.text), widths[i] - pad * 2, size, !!c.bold) };
      });
      const h = Math.max(1, ...cells.map((c) => c.lines.length)) * lh + pad * 2;
      if (this.y + h > this.bottom) { this.newPage(); drawHeader(); }
      if (zebra && r % 2 === 1) this.w.rect(this.margin, this.y, this.width, h, { fill: ZEBRA });
      let x = this.margin;
      cells.forEach((c, i) => {
        const align = columns[i].align === 'right' ? 'right' : 'left';
        const tx = align === 'right' ? x + widths[i] - pad : x + pad;
        c.lines.forEach((line, k) => {
          this.w.text(tx, this.y + pad + size + k * lh, line, { size, color: c.color || INK, bold: !!c.bold, align });
        });
        x += widths[i];
      });
      this.y += h;
      this.w.line(this.margin, this.y, this.margin + this.width, this.y, { color: RULE, width: 0.4 });
    });
    if (!rows.length) {
      this.ensure(lh + pad * 2);
      this.w.text(this.margin + pad, this.y + pad + size, 'None.', { size, color: DIM });
      this.y += lh + pad * 2;
    }
    if (note) this.paragraph(note, { size: 8, color: MUTED });
    this.y += 6;
  }

  image(name, imgW, imgH, { maxHeight = 240 } = {}) {
    const scale = Math.min(this.width / imgW, maxHeight / imgH, 1);
    const w = imgW * scale, h = imgH * scale;
    this.ensure(h + 8);
    this.w.image(name, this.margin, this.y, w, h);
    this.w.rect(this.margin, this.y, w, h, { stroke: RULE, lineWidth: 0.5 });
    this.y += h + 10;
  }

  /** Signature block: lines with captions, side by side. */
  signatures(labels) {
    const gap = 18;
    const colW = (this.width - gap * (labels.length - 1)) / labels.length;
    this.ensure(60);
    this.y += 26;
    labels.forEach((label, i) => {
      const x = this.margin + i * (colW + gap);
      this.w.line(x, this.y, x + colW, this.y, { color: INK, width: 0.6 });
      this.w.text(x, this.y + 11, label, { size: 8.5, color: MUTED });
    });
    this.y += 24;
  }

  /** Writes footers on every page and returns the bytes. */
  finish() {
    const n = this.w.pageCount;
    for (let p = 1; p <= n; p++) {
      this.w.usePage(p);
      const y = this.w.height - this.margin + 8;
      this.w.line(this.margin, y - 10, this.margin + this.width, y - 10, { color: RULE, width: 0.4 });
      this.w.text(this.margin, y, this.footer(p, n), { size: 7.5, color: DIM });
      this.w.text(this.margin + this.width, y, `Page ${p} of ${n}`, { size: 7.5, color: DIM, align: 'right' });
    }
    return this.w.build();
  }
}

// ------------------------------------------------------------ the report

const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
const fmtDate = (d) => new Date(d).toLocaleString('en-SG', { dateStyle: 'medium', timeStyle: 'short' });
const plural = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;

const SEV = { pass: 'pass', info: 'info', warn: 'warn', fail: 'fail' };

/**
 * @param {object} data
 * @param {object|null} data.project        the project document (see project.js)
 * @param {Array<{name: string, bytes: number, elements: number}>} data.models
 * @param {Array<{id: string, meta: object, result: object|null, error: Error|null}>} data.outcomes
 * @param {object[]} data.notRun            registry entries that were not selected
 * @param {{source?: string, generated?: string}} data.ruleset
 * @param {string} data.author
 * @param {{bytes: Uint8Array, width: number, height: number}|null} data.snapshot  JPEG
 * @param {Object<string, object[]>} data.edits  hand-edit log by file
 * @param {{gateway: string, authorities: string[]}} data.scope
 * @returns {Uint8Array} the PDF
 */
export function buildReadinessReport(data) {
  const { project, models, outcomes, notRun = [], ruleset = {}, author, snapshot, edits = {}, scope } = data;
  const code = project && project.project.code ? project.project.code : '';
  const name = project && project.project.name ? project.project.name : '';
  const generatedAt = new Date();
  const writer = new PdfWriter(A4);
  const flow = new Flow(writer, {
    footer: () => `RSP IFC-SG Viewer · ${[code, name].filter(Boolean).join(' ') || 'Submission readiness report'} · generated ${fmtDate(generatedAt)}`,
  });

  // ---- verdict
  const ran = outcomes.filter((o) => o.result);
  const errored = outcomes.filter((o) => o.error);
  const count = (sev) => ran.reduce((s, o) => s + (o.result.findings || []).filter((f) => f.severity === sev).length, 0);
  const fails = count(SEV.fail);
  const warns = count(SEV.warn);
  const ready = ran.length > 0 && errored.length === 0 && fails === 0;

  flow.heading('Submission Readiness Report', { level: 0 });
  flow.paragraph('CORENET X IFC-SG pre-submission check', { size: 10, color: MUTED });
  flow.space(4);
  flow.banner(
    ready ? 'READY FOR SUBMISSION' : 'NOT READY FOR SUBMISSION',
    ran.length === 0
      ? 'No checks were run.'
      : `${plural(ran.length, 'check')} run on ${plural(models.length, 'model file')}: ` +
        `${plural(fails, 'failure')}, ${plural(warns, 'warning')}` +
        (errored.length ? `, ${plural(errored.length, 'check')} could not run` : '') + '.',
    ready ? GREEN : RED);

  // ---- project
  flow.heading('Project');
  flow.keyValues([
    ['Project code', code || '—'],
    ['Development', name || '—'],
    ['Developer / client', project && project.project.developer],
    ['Cadastral lots', project && project.project.lots.length ? project.project.lots.join(', ') : null],
    ['Submission gateway', scope.gateway === 'design' ? 'Design Gateway' : 'Construction Gateway'],
    ['Authorities in scope', scope.authorities.length ? scope.authorities.join(', ') : 'All authorities'],
    ['IFC-SG ruleset', [ruleset.source, ruleset.generated ? 'generated ' + ruleset.generated : ''].filter(Boolean).join(', ')],
    ['Prepared by', author || '—'],
    ['Generated', fmtDate(generatedAt)],
  ]);

  if (snapshot) flow.image(writer.addJpeg(snapshot.bytes, snapshot.width, snapshot.height), snapshot.width, snapshot.height);

  // ---- models
  flow.heading('Model files checked');
  flow.table([
    { label: 'File', flex: 3 },
    { label: 'Size', width: 70, align: 'right' },
    { label: 'Elements indexed', width: 100, align: 'right' },
  ], models.map((m) => [m.name, fmtBytes(m.bytes), String(m.elements)]),
  { note: models.length > 1 ? 'The files were checked together as one federated model.' : null });

  // ---- check summary
  flow.heading('Checks');
  const statusCell = (o) => {
    if (o.error) return { text: 'Could not run', color: RED, bold: true };
    const s = o.result.summary;
    if (!s.assertions) return { text: 'Nothing to check', color: DIM };
    const f = (o.result.findings || []).filter((x) => x.severity === SEV.fail).length;
    const w = (o.result.findings || []).filter((x) => x.severity === SEV.warn).length;
    if (f) return { text: 'Fail', color: RED, bold: true };
    if (w) return { text: 'Pass with warnings', color: AMBER, bold: true };
    return { text: 'Pass', color: GREEN, bold: true };
  };
  const rows = outcomes.map((o) => {
    const s = o.result ? o.result.summary : { elements: 0, assertions: 0, pass: 0, fail: 0 };
    const f = o.result ? (o.result.findings || []).filter((x) => x.severity === SEV.fail).length : 0;
    const w = o.result ? (o.result.findings || []).filter((x) => x.severity === SEV.warn).length : 0;
    return [o.meta.title, o.meta.authority, String(s.elements), String(s.assertions), String(s.pass), String(f), String(w), statusCell(o)];
  });
  for (const meta of notRun) {
    rows.push([meta.title, meta.authority, '', '', '', '', '', { text: meta.experimental ? 'No rules yet' : 'Not run', color: DIM }]);
  }
  flow.table([
    { label: 'Check', flex: 3 },
    { label: 'Authority', width: 56 },
    { label: 'Elements', width: 52, align: 'right' },
    { label: 'Assertions', width: 58, align: 'right' },
    { label: 'Pass', width: 42, align: 'right' },
    { label: 'Fail', width: 40, align: 'right' },
    { label: 'Warn', width: 40, align: 'right' },
    { label: 'Result', width: 86 },
  ], rows, {
    note: notRun.length ? 'A check marked "Not run" was not selected for this run and is not covered by the verdict above.' : null,
  });

  // ---- per check detail
  for (const o of outcomes) {
    if (!o.result) continue;
    flow.heading(`${o.meta.title} (${o.meta.authority})`, { level: 2 });
    if (o.result.note) flow.paragraph(o.result.note, { size: 8.5, color: MUTED });

    const perRule = o.result.detail && Array.isArray(o.result.detail.perRule) ? o.result.detail.perRule : null;
    if (perRule && perRule.length) {
      flow.table([
        { label: 'Rule', flex: 4 },
        { label: 'Reference', width: 110 },
        { label: 'Tested', width: 44, align: 'right' },
        { label: 'Failed', width: 44, align: 'right' },
        { label: 'Result', width: 64 },
      ], perRule.map((st) => {
        const worst = st.findings.some((f) => f.severity === SEV.fail) ? 'fail'
          : st.findings.some((f) => f.severity === SEV.warn) ? 'warn' : 'pass';
        const result = st.skipped ? { text: 'Not applicable', color: DIM }
          : st.failed === 0 ? { text: 'Pass', color: GREEN, bold: true }
            : worst === 'fail' ? { text: 'Fail', color: RED, bold: true } : { text: 'Warning', color: AMBER, bold: true };
        return [st.rule.title, st.rule.reference || '', st.skipped ? '' : String(st.tested), st.skipped ? '' : String(st.failed), result];
      }));
    } else {
      // Findings grouped by the rule text they cite — for the IFC values check,
      // that is authority · component.
      const groups = new Map();
      for (const f of o.result.findings || []) {
        if (f.severity === SEV.pass) continue;
        const key = f.rule || f.label || o.meta.title;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = { fails: 0, warns: 0, issues: new Map() }));
        if (f.severity === SEV.fail) g.fails++; else if (f.severity === SEV.warn) g.warns++;
        const label = f.message || f.label || f.code;
        g.issues.set(label, (g.issues.get(label) || 0) + 1);
      }
      const list = [...groups.entries()].sort((a, b) => b[1].fails - a[1].fails || b[1].warns - a[1].warns);
      const shown = list.slice(0, 40);
      flow.table([
        { label: 'Component / rule', flex: 3 },
        { label: 'Failures', width: 52, align: 'right' },
        { label: 'Warnings', width: 56, align: 'right' },
        { label: 'Most frequent issue', flex: 3 },
      ], shown.map(([key, g]) => {
        const top = [...g.issues.entries()].sort((a, b) => b[1] - a[1])[0];
        return [key, String(g.fails), String(g.warns), top ? `${top[0]} (${top[1]})` : ''];
      }), { note: list.length > shown.length ? `${list.length - shown.length} more components with issues are not listed here.` : null });
    }
  }

  // ---- outstanding issues
  flow.heading('Outstanding failures');
  const failures = [];
  for (const o of ran) {
    for (const f of o.result.findings || []) {
      if (f.severity !== SEV.fail) continue;
      failures.push([o.meta.title, f.element ? (f.element.name || f.element.entity || '') : '—',
        f.element ? (f.element.globalId || '') : '', f.message || f.label || f.code]);
    }
  }
  const CAP = 150;
  flow.table([
    { label: 'Check', width: 80 },
    { label: 'Element', flex: 2 },
    { label: 'GlobalId', width: 118 },
    { label: 'Issue', flex: 3 },
  ], failures.slice(0, CAP), {
    size: 8,
    note: failures.length > CAP
      ? `${failures.length - CAP} further failures are not listed. The complete list is in the BCF export from the Issues tab.`
      : failures.length ? 'The complete list, with viewpoints, is available as a BCF export from the Issues tab.' : null,
  });

  if (warns) {
    flow.heading('Warnings');
    const list = [];
    for (const o of ran) {
      for (const f of o.result.findings || []) {
        if (f.severity !== SEV.warn) continue;
        list.push([o.meta.title, f.element ? (f.element.name || f.element.entity || '') : '—', f.message || f.label || f.code]);
      }
    }
    flow.table([
      { label: 'Check', width: 80 },
      { label: 'Element', flex: 2 },
      { label: 'Note', flex: 3 },
    ], list.slice(0, 60), { size: 8, note: list.length > 60 ? `${list.length - 60} further warnings are not listed.` : null });
  }

  // ---- hand edits
  const editRows = [];
  for (const [file, log] of Object.entries(edits)) {
    for (const e of log || []) {
      const what = e.op === 'rename' ? `Renamed to "${e.to}"`
        : e.op === 'remove' ? `Removed ${e.pset}.${e.prop}`
          : e.op === 'move' ? `Moved ${e.prop}: ${e.pset}`
            : `${e.op === 'add' ? 'Added' : 'Set'} ${e.pset}.${e.prop} = ${e.to}` + (e.from != null ? ` (was ${e.from})` : '');
      editRows.push([file, (e.element && (e.element.name || e.element.entity)) || '', (e.element && e.element.globalId) || '', what]);
    }
  }
  if (editRows.length) {
    flow.heading('Edits made in the viewer');
    flow.paragraph('These changes were written into a copy of the IFC by the viewer. They are not in the authoring model and will be lost on the next export unless the model is corrected there.', { size: 8.5, color: MUTED });
    flow.table([
      { label: 'File', flex: 2 },
      { label: 'Element', flex: 2 },
      { label: 'GlobalId', width: 118 },
      { label: 'Change', flex: 3 },
    ], editRows, { size: 8 });
  }

  // ---- declaration
  flow.heading('Declaration');
  flow.paragraph(
    'This report was generated by the RSP IFC-SG Viewer from the checks listed above, run on the model files named in this report against the CORENET X IFC-SG mapping. ' +
    'It records the state of the models at the time of the run. It supplements, and does not replace, the Qualified Person\'s own review of the submission for compliance with the CORENET X Code of Practice and the authorities\' requirements.',
    { size: 9 });
  flow.signatures(['Prepared by', 'Reviewed by (QP)', 'Date']);

  return flow.finish();
}
