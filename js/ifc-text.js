/**
 * The IFC file as text: a STEP (ISO 10303-21) layer over the original bytes.
 *
 * web-ifc parses a model for geometry and properties, and the app releases
 * that parse straight after indexing to keep memory down. Two later features
 * need the file itself again: editing, which must change a line and leave every
 * other byte as it was, and BCF import, which has to resolve any GUID in the
 * file whether or not the index kept the element. Both read from the File the
 * browser still holds rather than from a copy in memory.
 *
 * One chunked scan records where every `#id=` entity starts and ends, the GUID
 * of every entity that has one, the DATA section's closing ENDSEC, and the
 * schema declared in the header. Nothing is decoded during the scan except
 * entity names and GUIDs, so it runs in a few seconds on a 170 MB file with
 * no allocation beyond two typed arrays and the GUID map.
 */

const CHUNK = 8 * 1024 * 1024;

const HASH = 0x23, EQ = 0x3d, LPAREN = 0x28, QUOTE = 0x27, SEMI = 0x3b, NL = 0x0a, CR = 0x0d;

/**
 * Entities whose GUID is worth indexing. Everything under IfcRoot has one, but
 * relationships and property sets outnumber products several times over and
 * nothing outside the file refers to them by GUID.
 */
function keepsGuid(name) {
  return !(name.startsWith('IFCREL') || name.startsWith('IFCPROPERTY') ||
    name.startsWith('IFCQUANTITY') || name === 'IFCELEMENTQUANTITY' ||
    name.startsWith('IFCPRESENTATIONLAYER'));
}

/**
 * @typedef {object} TextScan
 * @property {File} file
 * @property {Uint32Array} starts   byte offset of `#` for each express id (0 = absent)
 * @property {Uint32Array} ends     byte offset one past the terminating `;`
 * @property {number} maxId
 * @property {number} count         entities found
 * @property {Map<string, number>} guidToId
 * @property {Map<string, number[]>} idsByEntity  ids per entity name, for the
 *           relationship and property-set lines editing has to read wholesale
 * @property {number} dataEnd       offset of the DATA section's `ENDSEC;`
 * @property {string|null} schema   FILE_SCHEMA, e.g. "IFC4"
 * @property {string} header        the header section text
 */

/**
 * Scans a file once. The state machine below reads byte by byte so an entity
 * that straddles a chunk boundary is handled like any other.
 * @param {File} file
 * @param {(pct: number) => void} [onProgress]
 * @returns {Promise<TextScan>}
 */
export async function scanFile(file, onProgress = () => {}) {
  let starts = new Uint32Array(1 << 16);
  let ends = new Uint32Array(1 << 16);
  const guidToId = new Map();
  const idsByEntity = new Map();
  let maxId = 0;
  let count = 0;
  let dataEnd = 0;
  let lastEndsec = 0;

  const grow = (id) => {
    let n = starts.length;
    while (n <= id) n *= 2;
    const s = new Uint32Array(n); s.set(starts); starts = s;
    const e = new Uint32Array(n); e.set(ends); ends = e;
  };

  // State across chunks.
  let mode = 0;          // 0 between entities, 1 reading id, 2 reading name, 3 in body
  let inString = false;
  let id = 0;
  let name = '';
  let start = 0;
  let sawGuid = 0;       // 0 not yet, 1 opening quote seen, 2 done
  let guid = '';
  let endsecMatch = 0;   // progress through "ENDSEC"
  const ENDSEC = [0x45, 0x4e, 0x44, 0x53, 0x45, 0x43];

  const size = file.size;
  for (let offset = 0; offset < size; offset += CHUNK) {
    const buf = new Uint8Array(await file.slice(offset, Math.min(size, offset + CHUNK)).arrayBuffer());
    const n = buf.length;
    for (let i = 0; i < n; i++) {
      const b = buf[i];
      if (mode === 0) {
        if (b === HASH) {
          mode = 1; id = 0; start = offset + i; name = ''; sawGuid = 0; guid = '';
          endsecMatch = 0;
        } else if (b === ENDSEC[endsecMatch]) {
          endsecMatch++;
          if (endsecMatch === 6) { lastEndsec = offset + i - 5; endsecMatch = 0; }
        } else {
          endsecMatch = 0;
        }
      } else if (mode === 1) {
        if (b >= 0x30 && b <= 0x39) id = id * 10 + (b - 0x30);
        else if (b === EQ) mode = 2;
        else mode = 0; // not an entity line after all
      } else if (mode === 2) {
        if (b === LPAREN) { mode = 3; inString = false; }
        else if (b > 0x20) name += String.fromCharCode(b);
      } else {
        // In the body: strings hide semicolons, and the first attribute of an
        // IfcRoot entity is its GUID, which is the only thing read here.
        if (inString) {
          if (b === QUOTE) { inString = false; if (sawGuid === 1) sawGuid = 2; }
          else if (sawGuid === 1 && guid.length < 22) guid += String.fromCharCode(b);
        } else if (b === QUOTE) {
          inString = true;
          if (sawGuid === 0) sawGuid = 1;
        } else if (b === SEMI) {
          if (id >= starts.length) grow(id);
          starts[id] = start;
          ends[id] = offset + i + 1;
          if (id > maxId) maxId = id;
          count++;
          if (sawGuid === 2 && guid.length === 22 && keepsGuid(name)) guidToId.set(guid, id);
          let list = idsByEntity.get(name);
          if (!list) idsByEntity.set(name, (list = []));
          list.push(id);
          mode = 0;
        } else if (sawGuid === 0 && b > 0x20) {
          sawGuid = 3; // first attribute is not a string: no GUID
        }
      }
    }
    onProgress(Math.min(100, Math.round(((offset + n) / size) * 100)));
    // Yield so the page stays responsive between chunks.
    await new Promise((r) => setTimeout(r, 0));
  }
  dataEnd = lastEndsec;

  const header = new TextDecoder().decode(new Uint8Array(await file.slice(0, Math.min(size, 8192)).arrayBuffer()));
  const m = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(header);

  return {
    file, starts, ends, maxId, count, guidToId, idsByEntity, dataEnd,
    schema: m ? m[1] : null,
    header: header.slice(0, header.indexOf('DATA;') > 0 ? header.indexOf('DATA;') : header.length),
  };
}

/**
 * The text of one entity line, or null when the id is not in the file.
 * @param {TextScan} scan
 */
export async function readLine(scan, id) {
  if (!(id > 0 && id <= scan.maxId && scan.ends[id])) return null;
  const start = scan.starts[id], end = scan.ends[id];
  const bytes = new Uint8Array(await scan.file.slice(start, end).arrayBuffer());
  return new TextDecoder().decode(bytes);
}

/**
 * The text of many entity lines, keyed by id. A handful are sliced directly;
 * a large set is gathered in one streaming pass so 300 000 relationship lines
 * do not mean 300 000 file reads.
 * @param {TextScan} scan
 * @param {number[]} ids
 * @returns {Promise<Map<number, string>>}
 */
export async function readLines(scan, ids) {
  const out = new Map();
  const wanted = ids.filter((id) => id > 0 && id <= scan.maxId && scan.ends[id]);
  if (!wanted.length) return out;
  const decoder = new TextDecoder();

  if (wanted.length <= 64) {
    await Promise.all(wanted.map(async (id) => {
      const bytes = new Uint8Array(await scan.file.slice(scan.starts[id], scan.ends[id]).arrayBuffer());
      out.set(id, decoder.decode(bytes));
    }));
    return out;
  }

  wanted.sort((a, b) => scan.starts[a] - scan.starts[b]);
  let k = 0;
  const size = scan.file.size;
  const first = scan.starts[wanted[0]];
  for (let offset = first - (first % CHUNK); offset < size && k < wanted.length; offset += CHUNK) {
    const chunkEnd = Math.min(size, offset + CHUNK);
    if (scan.starts[wanted[k]] >= chunkEnd) continue;
    // Read enough to cover any line that straddles this chunk's end.
    let readEnd = chunkEnd;
    for (let j = k; j < wanted.length && scan.starts[wanted[j]] < chunkEnd; j++) {
      if (scan.ends[wanted[j]] > readEnd) readEnd = scan.ends[wanted[j]];
    }
    const buf = new Uint8Array(await scan.file.slice(offset, readEnd).arrayBuffer());
    while (k < wanted.length && scan.starts[wanted[k]] < chunkEnd) {
      const id = wanted[k++];
      out.set(id, decoder.decode(buf.subarray(scan.starts[id] - offset, scan.ends[id] - offset)));
    }
  }
  return out;
}

// ------------------------------------------------------------- STEP values

/**
 * A parsed STEP entity line.
 * @typedef {object} StepLine
 * @property {number} id
 * @property {string} name   upper-case entity name
 * @property {StepValue[]} attrs
 */

/**
 * A STEP attribute value.
 * @typedef {{kind: 'null'} | {kind: 'derived'} | {kind: 'ref', id: number} |
 *   {kind: 'str', value: string} | {kind: 'enum', value: string} |
 *   {kind: 'num', raw: string} | {kind: 'list', items: StepValue[]} |
 *   {kind: 'typed', name: string, value: StepValue}} StepValue
 */

export const NULL = { kind: 'null' };
export const ref = (id) => ({ kind: 'ref', id });
export const str = (value) => ({ kind: 'str', value });
export const enumv = (value) => ({ kind: 'enum', value });
export const num = (n) => ({ kind: 'num', raw: typeof n === 'number' ? formatNumber(n) : String(n) });
export const list = (items) => ({ kind: 'list', items });
export const typed = (name, value) => ({ kind: 'typed', name: name.toUpperCase(), value });

/** STEP REAL literals must carry a decimal point. */
function formatNumber(n) {
  if (!Number.isFinite(n)) return '0.';
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(12).replace(/0+$/, '');
  if (!s.includes('.')) s += '.';
  return s;
}

/** Parses `#12=IFCWALL('guid',#5,...);` into a StepLine. */
export function parseLine(text) {
  const m = /^\s*#(\d+)\s*=\s*([A-Za-z0-9_]+)\s*\(/.exec(text);
  if (!m) throw new Error('Not an entity line: ' + text.slice(0, 60));
  const id = Number(m[1]);
  const name = m[2].toUpperCase();
  const p = { s: text, i: m[0].length };
  const attrs = parseListBody(p);
  return { id, name, attrs };
}

function parseListBody(p) {
  const items = [];
  skipWs(p);
  if (p.s[p.i] === ')') { p.i++; return items; }
  for (;;) {
    items.push(parseValue(p));
    skipWs(p);
    const c = p.s[p.i++];
    if (c === ',') continue;
    if (c === ')') return items;
    throw new Error(`Bad STEP syntax at ${p.i}: "${p.s.slice(Math.max(0, p.i - 20), p.i + 20)}"`);
  }
}

function skipWs(p) {
  while (p.i < p.s.length && /\s/.test(p.s[p.i])) p.i++;
}

function parseValue(p) {
  skipWs(p);
  const c = p.s[p.i];
  if (c === '$') { p.i++; return NULL; }
  if (c === '*') { p.i++; return { kind: 'derived' }; }
  if (c === '#') {
    const m = /^#(\d+)/.exec(p.s.slice(p.i));
    p.i += m[0].length;
    return ref(Number(m[1]));
  }
  if (c === "'") {
    let j = p.i + 1;
    let out = '';
    for (;;) {
      const q = p.s.indexOf("'", j);
      if (q < 0) throw new Error('Unterminated string');
      out += p.s.slice(j, q);
      if (p.s[q + 1] === "'") { out += "'"; j = q + 2; continue; }
      p.i = q + 1;
      return str(decodeString(out));
    }
  }
  if (c === '.') {
    const m = /^\.([A-Za-z0-9_]+)\./.exec(p.s.slice(p.i));
    p.i += m[0].length;
    return enumv(m[1]);
  }
  if (c === '(') {
    p.i++;
    return list(parseListBody(p));
  }
  const numMatch = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(p.s.slice(p.i));
  if (numMatch) {
    p.i += numMatch[0].length;
    return { kind: 'num', raw: numMatch[0] };
  }
  const typedMatch = /^([A-Za-z0-9_]+)\s*\(/.exec(p.s.slice(p.i));
  if (typedMatch) {
    p.i += typedMatch[0].length;
    const inner = parseValue(p);
    skipWs(p);
    if (p.s[p.i++] !== ')') throw new Error('Bad typed value');
    return typed(typedMatch[1], inner);
  }
  throw new Error(`Unexpected "${c}" at ${p.i}`);
}

/** Serialises a StepLine back to `#id=NAME(...);`. */
export function serialiseLine(line) {
  return `#${line.id}=${line.name}(${line.attrs.map(serialiseValue).join(',')});`;
}

export function serialiseValue(v) {
  switch (v.kind) {
    case 'null': return '$';
    case 'derived': return '*';
    case 'ref': return '#' + v.id;
    case 'str': return "'" + encodeString(v.value) + "'";
    case 'enum': return '.' + v.value + '.';
    case 'num': return v.raw;
    case 'list': return '(' + v.items.map(serialiseValue).join(',') + ')';
    case 'typed': return v.name + '(' + serialiseValue(v.value) + ')';
    default: throw new Error('Unknown STEP value kind ' + v.kind);
  }
}

/**
 * STEP string encoding: `''` for an apostrophe, and characters outside
 * Latin-1 as `\X2\` UTF-16BE hex runs, which is what Revit writes.
 */
export function encodeString(s) {
  let out = '';
  let run = '';
  const flush = () => { if (run) { out += '\\X2\\' + run + '\\X0\\'; run = ''; } };
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code > 0xff) {
      if (code > 0xffff) {
        // Surrogate pair, two UTF-16 units.
        const hi = Math.floor((code - 0x10000) / 0x400) + 0xd800;
        const lo = ((code - 0x10000) % 0x400) + 0xdc00;
        run += hi.toString(16).toUpperCase().padStart(4, '0') + lo.toString(16).toUpperCase().padStart(4, '0');
      } else {
        run += code.toString(16).toUpperCase().padStart(4, '0');
      }
      continue;
    }
    flush();
    if (ch === "'") out += "''";
    else if (ch === '\\') out += '\\\\';
    else if (code > 0x7e) out += '\\X\\' + code.toString(16).toUpperCase().padStart(2, '0');
    else out += ch;
  }
  flush();
  return out;
}

/** The inverse of encodeString; `''` has already been collapsed by the parser. */
export function decodeString(s) {
  if (!s.includes('\\')) return s;
  return s
    .replace(/\\X2\\([0-9A-Fa-f]*)\\X0\\/g, (_, hex) => {
      let out = '';
      for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      return out;
    })
    .replace(/\\X4\\([0-9A-Fa-f]*)\\X0\\/g, (_, hex) => {
      let out = '';
      for (let i = 0; i + 8 <= hex.length; i += 8) out += String.fromCodePoint(parseInt(hex.slice(i, i + 8), 16));
      return out;
    })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_, c) => String.fromCharCode(c.charCodeAt(0) + 128))
    .replace(/\\\\/g, '\\');
}

/** The plain JS value inside a (possibly typed) STEP value, for display. */
export function plainValue(v) {
  if (!v) return null;
  switch (v.kind) {
    case 'null': case 'derived': return null;
    case 'str': return v.value;
    case 'enum': return v.value === 'T' ? true : v.value === 'F' ? false : v.value;
    case 'num': return Number(v.raw);
    case 'typed': return plainValue(v.value);
    case 'ref': return '#' + v.id;
    case 'list': return v.items.map(plainValue);
    default: return null;
  }
}
