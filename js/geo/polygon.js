/**
 * Plane geometry on closed rings, in projected metres.
 *
 * Everything here works on a ring given as `[[x, y], …]`. Rings arrive from two
 * places — a cadastral lot projected out of GeoJSON, and a footprint taken from
 * the model — and the check compares them, so both sides use these functions and
 * there is one definition of "inside" and "distance".
 */

/** Signed area. Positive is counter-clockwise; the sign also gives orientation. */
export function signedArea(ring) {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export const area = (ring) => Math.abs(signedArea(ring));

export function centroid(ring) {
  const a = signedArea(ring);
  if (!a) {
    // Degenerate ring (all points collinear): fall back to the mean.
    const m = ring.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
    return [m[0] / ring.length, m[1] / ring.length];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return [cx / (6 * a), cy / (6 * a)];
}

export function bounds(ring) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Ray-casting point-in-polygon. A point exactly on an edge may go either way. */
export function pointInRing(point, ring) {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Shortest distance from a point to a line segment. */
function distanceToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Shortest distance from a point to a ring's boundary, ignoring inside/outside. */
export function distanceToRing(point, ring) {
  const [px, py] = point;
  let best = Infinity;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    const d = distanceToSegment(px, py, x1, y1, x2, y2);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Signed distance from a point to a ring: negative inside, positive outside.
 * This is what lets one number express both "is it in?" and "by how much?".
 */
export function signedDistanceToRing(point, ring) {
  const d = distanceToRing(point, ring);
  return pointInRing(point, ring) ? -d : d;
}

/**
 * Convex hull (monotone chain), counter-clockwise.
 *
 * A model footprint is taken from raw mesh vertices, which are an unordered
 * cloud rather than an outline, so a hull is the honest summary of where the
 * model sits. It overstates a concave footprint, which is why the check uses it
 * for containment — where overstating is conservative — and says so in its report.
 */
export function convexHull(points) {
  if (points.length < 3) return points.slice();

  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Reduces a ring to points at least `minGap` apart, keeping its shape.
 *
 * A hull built from a dense mesh can carry thousands of nearly-coincident
 * points; drawing and reporting both get slower with no gain in accuracy.
 */
export function simplify(ring, minGap = 0.05) {
  if (ring.length < 3) return ring.slice();
  const out = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const last = out[out.length - 1];
    if (Math.hypot(ring[i][0] - last[0], ring[i][1] - last[1]) >= minGap) out.push(ring[i]);
  }
  // Drop a final point that has closed back onto the first.
  if (out.length > 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(last[0] - first[0], last[1] - first[1]) < minGap) out.pop();
  }
  return out;
}
