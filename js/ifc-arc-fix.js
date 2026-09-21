/**
 * Straightens curved profile boundaries before web-ifc ever sees them.
 *
 * Revit exports a rounded corner in a floor or geographic-element boundary as
 * an IfcIndexedPolyCurve with one segment marked IFCARCINDEX — three point
 * indices, the middle one lying on the true arc. web-ifc 0.0.36 (and 0.0.77,
 * the newest release, tested the same way) fails to tessellate an extruded
 * solid whose profile contains such a segment: the resulting mesh keeps only
 * a sliver of the true footprint, sometimes none of it at all. That is the
 * "missing chunk" a site boundary or planting area can show in the viewer.
 *
 * The fix runs before the file reaches web-ifc: every IFCARCINDEX segment is
 * replaced with a dense IFCLINEINDEX polyline that follows the same true
 * circular arc, and the extra points are appended to the point list it draws
 * from. Nothing else in the file changes — no entity is added, removed or
 * renumbered, so every expressID a property, relationship or GUID lookup
 * depends on stays exactly where it was. This is only ever used to build the
 * mesh and the property index; editing, export and model identity keep
 * reading the original bytes (the caller is responsible for that — see
 * `loadFiles` in app.js, which restores `entry.file` afterwards).
 */

import { scanFile, readLines, parseLine, serialiseLine, num } from './ifc-text.js';

const TAU = Math.PI * 2;

/** A STEP integer attribute — no decimal point, unlike a REAL. */
const int = (n) => ({ kind: 'num', raw: String(Math.round(n)) });

/** Squared distance between two same-length coordinate arrays. */
function dist2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

/**
 * The centre of the circle through three points, by the barycentric weights
 * a²(b²+c²−a²) : b²(c²+a²−b²) : c²(a²+b²−c²) (a, b, c the side lengths).
 * Works for a 2D or a 3D point alike, since it is only ever a weighted sum of
 * the three position vectors.
 * @returns {number[]|null} null when the points are collinear
 */
function circumcentre(A, B, C) {
  const a2 = dist2(B, C), b2 = dist2(C, A), c2 = dist2(A, B);
  const wa = a2 * (b2 + c2 - a2);
  const wb = b2 * (c2 + a2 - b2);
  const wc = c2 * (a2 + b2 - c2);
  const w = wa + wb + wc;
  if (!Number.isFinite(w) || Math.abs(w) < 1e-9) return null;
  return A.map((_, i) => (wa * A[i] + wb * B[i] + wc * C[i]) / w);
}

/**
 * Points along the true arc from A through B to C, excluding the endpoints.
 *
 * Builds an orthonormal (u, v) basis at the circle's centre by Gram-Schmidt
 * on B — u toward A, v the part of the direction to B perpendicular to u —
 * so B always falls at a positive angle. That fixes which of the two ways
 * round the circle is "the arc", and the same construction works for a 2D or
 * a 3D point list without a separate case for either.
 * @returns {number[][]|null} null when no usable circle exists
 */
function arcPoints(A, B, C) {
  const O = circumcentre(A, B, C);
  if (!O) return null;
  const sub = (P) => P.map((v, i) => v - O[i]);
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const norm = (a) => Math.sqrt(dot(a, a));

  const oa = sub(A), ob = sub(B);
  const r = norm(oa);
  if (!(r > 1e-9)) return null;
  const u = oa.map((v) => v / r);
  const ub = dot(ob, u);
  const vRaw = ob.map((v, i) => v - ub * u[i]);
  const vLen = norm(vRaw);
  if (!(vLen > 1e-9)) return null; // A, B and the centre are collinear
  const v = vRaw.map((x) => x / vLen);

  const angle = (P) => { const op = sub(P); return Math.atan2(dot(op, v), dot(op, u)); };
  const thetaB = angle(B); // in (0, π) by construction of v from B
  let thetaC = angle(C);
  if (thetaC < thetaB) thetaC += TAU; // the arc passes through B before C

  const segments = Math.min(32, Math.max(4, Math.round(Math.abs(thetaC) / (Math.PI / 18))));
  const points = [];
  for (let k = 1; k < segments; k++) {
    const t = (thetaC * k) / segments;
    const ct = Math.cos(t), st = Math.sin(t);
    points.push(O.map((c, i) => c + r * (ct * u[i] + st * v[i])));
  }
  return points;
}

/**
 * Replaces every IFCARCINDEX segment in the file's IfcIndexedPolyCurve
 * entities with a straight-line approximation of the same arc.
 * @param {File} file
 * @param {(pct: number) => void} [onProgress]
 * @returns {Promise<{file: File|null, curvesFixed: number, arcsFixed: number}>}
 *   `file` is null when nothing needed changing — load the original as-is.
 */
export async function flattenArcs(file, onProgress = () => {}) {
  const scan = await scanFile(file, onProgress);
  const curveIds = scan.idsByEntity.get('IFCINDEXEDPOLYCURVE') || [];
  if (!curveIds.length) return { file: null, curvesFixed: 0, arcsFixed: 0 };

  const curveTexts = await readLines(scan, curveIds);
  const curveById = new Map();
  for (const id of curveIds) {
    const text = curveTexts.get(id);
    if (!text) continue;
    let line;
    try { line = parseLine(text); } catch { continue; }
    const segs = line.attrs[1];
    if (!segs || segs.kind !== 'list') continue;
    if (segs.items.some((s) => s.kind === 'typed' && s.name === 'IFCARCINDEX')) curveById.set(id, line);
  }
  if (!curveById.size) return { file: null, curvesFixed: 0, arcsFixed: 0 };

  const pointListIds = [...new Set([...curveById.values()]
    .map((c) => c.attrs[0])
    .filter((v) => v && v.kind === 'ref')
    .map((v) => v.id))];
  const pointTexts = await readLines(scan, pointListIds);
  const pointLists = new Map(); // id -> { line, items, next }
  for (const id of pointListIds) {
    const text = pointTexts.get(id);
    if (!text) continue;
    let line;
    try { line = parseLine(text); } catch { continue; }
    const coords = line.attrs[0];
    if (!coords || coords.kind !== 'list') continue;
    pointLists.set(id, { line, items: coords.items, next: coords.items.length + 1 });
  }

  let arcsFixed = 0;
  const touchedCurves = new Set();
  const touchedPointLists = new Set();

  for (const curve of curveById.values()) {
    const pref = curve.attrs[0];
    const pl = pref && pref.kind === 'ref' ? pointLists.get(pref.id) : null;
    if (!pl) continue;
    const coordAt = (idx1) => {
      const item = pl.items[idx1 - 1];
      return item && item.kind === 'list' ? item.items.map((n) => Number(n.raw)) : null;
    };

    const segs = curve.attrs[1].items;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!(seg.kind === 'typed' && seg.name === 'IFCARCINDEX')) continue;
      const idx = seg.value.items.map((n) => Number(n.raw));
      if (idx.length !== 3) continue;
      const [ia, ib, ic] = idx;
      const A = coordAt(ia), B = coordAt(ib), C = coordAt(ic);
      if (!A || !B || !C) continue;

      const mids = arcPoints(A, B, C);
      if (!mids || !mids.length) continue; // collinear or degenerate: leave it as-is

      const newIdx = [];
      for (const P of mids) {
        pl.items.push({ kind: 'list', items: P.map((v) => num(v)) });
        newIdx.push(pl.next++);
      }

      segs[i] = { kind: 'typed', name: 'IFCLINEINDEX', value: { kind: 'list', items: [ia, ...newIdx, ic].map(int) } };
      touchedCurves.add(curve.id);
      touchedPointLists.add(pref.id);
      arcsFixed++;
    }
  }
  if (!arcsFixed) return { file: null, curvesFixed: 0, arcsFixed: 0 };

  // Splice only the touched lines into the original bytes — see editor.js's
  // export(), which this mirrors: nothing else is read into memory twice.
  const enc = new TextEncoder();
  const changes = [
    ...[...touchedCurves].map((id) => ({ id, text: serialiseLine(curveById.get(id)) })),
    ...[...touchedPointLists].map((id) => ({ id, text: serialiseLine(pointLists.get(id).line) })),
  ].filter((c) => scan.ends[c.id]).sort((a, b) => scan.starts[a.id] - scan.starts[b.id]);

  const parts = [];
  let cursor = 0;
  for (const c of changes) {
    const start = scan.starts[c.id], end = scan.ends[c.id];
    if (start > cursor) parts.push(file.slice(cursor, start));
    parts.push(enc.encode(c.text));
    cursor = end;
  }
  if (cursor < file.size) parts.push(file.slice(cursor));

  const blob = new Blob(parts, { type: file.type || 'application/octet-stream' });
  const patched = new File([blob], file.name, { type: file.type });
  return { file: patched, curvesFixed: touchedCurves.size, arcsFixed };
}
