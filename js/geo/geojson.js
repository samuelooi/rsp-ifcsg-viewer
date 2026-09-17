/**
 * Reads the cadastral lot GeoJSON that URA's site-information service exports.
 *
 * The service hands out a FeatureCollection of land-lot polygons in WGS84
 * longitude/latitude, one feature per lot, with the lot key in the properties.
 * A development may span several lots, and the URA checker takes exactly one
 * file per run — so several lots in one file is the normal case, not an error.
 */

import { lonLatToSvy21 } from './svy21.js';

/**
 * @typedef {object} Lot
 * @property {string} key     lot number, e.g. "MK29-03332M"
 * @property {Array<[number,number]>} ringWgs84   outer ring, lon/lat
 * @property {Array<[number,number]>} ring        same ring projected to SVY21 E/N
 * @property {Array<Array<[number,number]>>} holes  inner rings, SVY21
 * @property {number|null} declaredArea  the area the service states, m²
 */

/** Pulls the outer ring and any holes out of one GeoJSON geometry. */
function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

const isCoordPair = (p) =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/**
 * Longitude/latitude, or already-projected coordinates?
 *
 * URA exports degrees, but a file re-saved from a GIS tool can arrive already in
 * SVY21 metres. Telling them apart by magnitude is safe here because the two
 * ranges cannot overlap: Singapore is near 1°N 104°E, and SVY21 values are tens
 * of thousands of metres.
 */
function looksLikeDegrees(ring) {
  return ring.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90);
}

/**
 * Parses GeoJSON text into lots with SVY21 rings.
 * @param {string} text
 * @returns {{lots: Lot[], sourceCrs: string, warnings: string[]}}
 */
export function parseCadastralGeoJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('That file is not valid JSON, so it cannot be read as GeoJSON.');
  }

  const warnings = [];

  // A named CRS other than WGS84 would silently misplace everything, so refuse
  // rather than guess. The default for GeoJSON, and what URA exports, is WGS84.
  const crsName = data.crs && data.crs.properties && data.crs.properties.name;
  if (crsName && !/CRS84|4326|WGS ?84/i.test(String(crsName))) {
    warnings.push(`The file declares the coordinate system "${crsName}". ` +
      'It is being read as longitude/latitude, which may be wrong.');
  }

  const features = data.type === 'FeatureCollection' ? (data.features || [])
    : data.type === 'Feature' ? [data]
      : data.type === 'Polygon' || data.type === 'MultiPolygon' ? [{ geometry: data, properties: {} }]
        : [];

  if (!features.length) {
    throw new Error('No polygon features were found in that GeoJSON file.');
  }

  const lots = [];
  let degreesSeen = false;

  for (const feature of features) {
    const props = feature.properties || {};
    for (const polygon of ringsOf(feature.geometry)) {
      const [outer, ...holes] = polygon;
      if (!Array.isArray(outer) || outer.length < 3) continue;

      const clean = outer.filter(isCoordPair).map(([x, y]) => [x, y]);
      if (clean.length < 3) continue;

      const degrees = looksLikeDegrees(clean);
      degreesSeen = degreesSeen || degrees;
      const project = (pts) => (degrees
        ? pts.map(([lon, lat]) => { const { E, N } = lonLatToSvy21(lon, lat); return [E, N]; })
        : pts.map(([x, y]) => [x, y]));

      // GeoJSON rings repeat the first point last; a closed duplicate would
      // add a zero-length edge to every distance and area calculation.
      const ring = project(clean);
      if (ring.length > 1) {
        const [fx, fy] = ring[0];
        const [lx, ly] = ring[ring.length - 1];
        if (Math.hypot(lx - fx, ly - fy) < 1e-6) ring.pop();
      }

      lots.push({
        key: String(props.LOT_KEY || props.lot_key || props.name || props.NAME || 'Lot ' + (lots.length + 1)),
        ringWgs84: degrees ? clean : null,
        ring,
        holes: holes.filter((h) => Array.isArray(h) && h.length >= 3).map((h) => project(h.filter(isCoordPair))),
        declaredArea: Number.isFinite(props['SHAPE_1.AREA']) ? props['SHAPE_1.AREA']
          : Number.isFinite(props.SHAPE_AREA) ? props.SHAPE_AREA : null,
      });
    }
  }

  if (!lots.length) throw new Error('No usable polygon rings were found in that GeoJSON file.');

  return {
    lots,
    sourceCrs: degreesSeen ? 'WGS84 longitude/latitude' : 'already projected (assumed SVY21)',
    warnings,
  };
}

/**
 * Parses the manual fallback: three surveyed vertices in SVY21.
 *
 * The URA checker offers this for a development whose lot is not in the
 * cadastral database. Accepts one "easting, northing" pair per line, or all
 * six numbers separated by commas.
 * @returns {Array<[number,number]>}
 */
export function parseVertices(text) {
  const numbers = String(text || '')
    .split(/[\s,;]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));

  if (numbers.length < 6) {
    throw new Error('Three vertices are needed — six numbers as easting, northing pairs.');
  }
  const pts = [];
  for (let i = 0; i + 1 < numbers.length && pts.length < 3; i += 2) {
    pts.push([numbers[i], numbers[i + 1]]);
  }
  return pts;
}
