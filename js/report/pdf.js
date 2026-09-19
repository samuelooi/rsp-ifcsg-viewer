/**
 * A small PDF writer: text in the two standard Helvetica faces, rules and
 * filled boxes, and JPEG images. Enough for a report, with no library.
 *
 * Coordinates given to the drawing calls are in points from the top-left of
 * the page, which is how a layout thinks; they are flipped to PDF's bottom-up
 * space on output. Text is encoded as WinAnsi, which the base-14 fonts read
 * without any font being embedded; the few typographic characters a report
 * uses (dashes, bullets, quotes) map onto it, and anything else becomes "?".
 */

export const A4 = { width: 595.28, height: 841.89 };

// Advance widths (per 1000 em) for WinAnsi 32..126, from the AFM files.
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

/** Unicode -> WinAnsi byte for the characters a report is likely to carry. */
const WINANSI = new Map([
  ['•', 0x95], ['·', 0xb7], ['–', 0x96], ['—', 0x97], ['…', 0x85],
  ['‘', 0x91], ['’', 0x92], ['“', 0x93], ['”', 0x94], [' ', 0x20],
  ['°', 0xb0], ['²', 0xb2], ['³', 0xb3], ['×', 0xd7], ['é', 0xe9],
  ['è', 0xe8], ['ü', 0xfc], ['ö', 0xf6], ['ä', 0xe4], ['ç', 0xe7],
  ['©', 0xa9], ['®', 0xae], ['™', 0x99], ['€', 0x80],
]);
const REPLACE = new Map([
  ['≤', '<='], ['≥', '>='], ['→', '->'], ['←', '<-'], ['✓', 'Yes'],
  ['✗', 'No'], ['✘', 'No'], ['✔', 'Yes'], ['⇄', '<->'], ['×', 'x'],
]);

/** The WinAnsi bytes for a string, with unrepresentable characters replaced. */
function encodeText(s) {
  const out = [];
  for (const ch of String(s == null ? '' : s)) {
    const code = ch.codePointAt(0);
    if (code < 0x80) { out.push(code); continue; }
    if (WINANSI.has(ch)) { out.push(WINANSI.get(ch)); continue; }
    if (REPLACE.has(ch)) { for (const c of REPLACE.get(ch)) out.push(c.charCodeAt(0)); continue; }
    if (code >= 0xa0 && code <= 0xff) { out.push(code); continue; }
    out.push(0x3f);
  }
  return out;
}

function escapeBytes(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += '\\' + String.fromCharCode(b);
    else if (b < 0x20 || b > 0x7e) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => c.map((v) => num(v / 255)).join(' ');

export class PdfWriter {
  constructor({ width = A4.width, height = A4.height } = {}) {
    this.width = width;
    this.height = height;
    this.pages = [];
    this.images = [];  // { name, bytes, width, height }
    this.page = null;
  }

  addPage() {
    this.page = { ops: [] };
    this.pages.push(this.page);
    return this.pages.length;
  }

  get pageCount() {
    return this.pages.length;
  }

  /** Draws onto an earlier page, for footers written once the count is known. */
  usePage(n) {
    this.page = this.pages[n - 1];
  }

  /** Width of a string at a size, for wrapping and alignment. */
  textWidth(s, size, bold = false) {
    const table = bold ? HELVETICA_BOLD : HELVETICA;
    let w = 0;
    for (const b of encodeText(s)) {
      w += b >= 32 && b <= 126 ? table[b - 32] : 556;
    }
    return (w / 1000) * size;
  }

  /**
   * Draws text with its baseline at `y` from the top of the page.
   * @param {object} [o]  size, bold, color [r,g,b] 0-255, align 'left'|'right'|'center' about x
   */
  text(x, y, s, { size = 10, bold = false, color = [0, 0, 0], align = 'left' } = {}) {
    const bytes = encodeText(s);
    if (!bytes.length) return;
    let x0 = x;
    if (align !== 'left') {
      const w = this.textWidth(s, size, bold);
      x0 = align === 'right' ? x - w : x - w / 2;
    }
    this.page.ops.push(
      `BT ${rgb(color)} rg /${bold ? 'F2' : 'F1'} ${num(size)} Tf 1 0 0 1 ${num(x0)} ${num(this.height - y)} Tm (${escapeBytes(bytes)}) Tj ET`);
  }

  rect(x, y, w, h, { fill = null, stroke = null, lineWidth = 0.5 } = {}) {
    const parts = [];
    if (fill) parts.push(`${rgb(fill)} rg`);
    if (stroke) parts.push(`${rgb(stroke)} RG ${num(lineWidth)} w`);
    parts.push(`${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(h)} re`);
    parts.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
    this.page.ops.push(parts.join(' '));
  }

  line(x1, y1, x2, y2, { color = [0, 0, 0], width = 0.5 } = {}) {
    this.page.ops.push(
      `${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S`);
  }

  /** Registers a JPEG for drawing; returns its name. */
  addJpeg(bytes, width, height) {
    const name = 'Im' + (this.images.length + 1);
    this.images.push({ name, bytes, width, height });
    return name;
  }

  image(name, x, y, w, h) {
    this.page.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(this.height - y - h)} cm /${name} Do Q`);
  }

  /** The finished file. */
  build() {
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let length = 0;
    const push = (part) => {
      const bytes = typeof part === 'string' ? latin1(part) : part;
      chunks.push(bytes);
      length += bytes.length;
    };
    const obj = (n, body) => {
      offsets[n] = length;
      push(`${n} 0 obj\n`);
      if (typeof body === 'string') push(body);
      else for (const p of body) push(p);
      push('\nendobj\n');
    };

    push('%PDF-1.4\n%âãÏÓ\n');

    // Object numbering: 1 catalog, 2 pages, 3 F1, 4 F2, images, then page + content pairs.
    const imageBase = 5;
    const pageBase = imageBase + this.images.length;
    const total = pageBase + this.pages.length * 2 - 1;

    const kids = this.pages.map((_, i) => `${pageBase + i * 2} 0 R`).join(' ');
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

    this.images.forEach((im, i) => {
      obj(imageBase + i, [
        `<< /Type /XObject /Subtype /Image /Width ${im.width} /Height ${im.height} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`,
        im.bytes, '\nendstream',
      ]);
    });

    const xobjects = this.images.map((im, i) => `/${im.name} ${imageBase + i} 0 R`).join(' ');
    this.pages.forEach((page, i) => {
      const pageNo = pageBase + i * 2;
      const contentNo = pageNo + 1;
      obj(pageNo,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xobjects} >> >> /Contents ${contentNo} 0 R >>`);
      const content = latin1(page.ops.join('\n'));
      obj(contentNo, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    });

    const xref = length;
    push(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
    for (let n = 1; n <= total; n++) push(String(offsets[n]).padStart(10, '0') + ' 00000 n \n');
    push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    void enc;
    return out;
  }
}

/** Bytes of a string whose characters are all below 256. */
function latin1(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
