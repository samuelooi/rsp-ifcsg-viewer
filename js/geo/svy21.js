/**
 * SVY21 (EPSG:3414) — Singapore's national projected coordinate system.
 *
 * URA publishes cadastral lots as GeoJSON in WGS84 longitude/latitude, while an
 * IFC model georeferenced for Singapore carries SVY21 eastings and northings. To
 * compare the two, one has to be projected into the other, and this is that
 * projection.
 *
 * SVY21 is a Transverse Mercator projection on the WGS84 ellipsoid:
 *
 *   origin        1° 22′ 00″ N, 103° 50′ 00″ E
 *   false easting     28001.642 m
 *   false northing    38744.572 m
 *   scale factor      1.0
 *
 * The series expansion below is the standard one for Transverse Mercator,
 * carried to enough terms that the error over Singapore is well under a
 * millimetre — which matters, because the tolerance this feeds is ±20 mm.
 */

const A = 6378137.0;                 // WGS84 semi-major axis
const F = 1 / 298.257223563;         // WGS84 flattening
const ORIGIN_LAT = 1.366666666666667;
const ORIGIN_LON = 103.8333333333333;
const FALSE_NORTHING = 38744.572;
const FALSE_EASTING = 28001.642;
const K = 1.0;

const B = A * (1 - F);
const E2 = 2 * F - F * F;
const E4 = E2 * E2;
const E6 = E4 * E2;

const A0 = 1 - E2 / 4 - 3 * E4 / 64 - 5 * E6 / 256;
const A2 = (3 / 8) * (E2 + E4 / 4 + 15 * E6 / 128);
const A4 = (15 / 256) * (E4 + 3 * E6 / 4);
const A6 = 35 * E6 / 3072;

const N_ = (A - B) / (A + B);
const N2 = N_ * N_;
const N3 = N2 * N_;
const N4 = N3 * N_;
const G = A * (1 - N_) * (1 - N2) * (1 + 9 * N2 / 4 + 225 * N4 / 64) * (Math.PI / 180);

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Meridian distance from the equator to `latRad`. */
function meridianDistance(latRad) {
  return A * (A0 * latRad - A2 * Math.sin(2 * latRad) +
    A4 * Math.sin(4 * latRad) - A6 * Math.sin(6 * latRad));
}

/**
 * WGS84 longitude/latitude to SVY21 easting/northing, both in metres.
 * @param {number} lon degrees east
 * @param {number} lat degrees north
 * @returns {{E: number, N: number}}
 */
export function lonLatToSvy21(lon, lat) {
  const latR = rad(lat);
  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const sin2 = sinLat * sinLat;

  const rho = (A * (1 - E2)) / Math.pow(1 - E2 * sin2, 1.5);
  const v = A / Math.sqrt(1 - E2 * sin2);
  const psi = v / rho;
  const t = Math.tan(latR);
  const t2 = t * t;
  const t4 = t2 * t2;
  const t6 = t4 * t2;
  const psi2 = psi * psi;
  const psi3 = psi2 * psi;
  const psi4 = psi3 * psi;

  const w = rad(lon - ORIGIN_LON);
  const w2 = w * w;
  const w4 = w2 * w2;
  const w6 = w4 * w2;
  const w8 = w6 * w2;

  const c2 = cosLat * cosLat;
  const c3 = c2 * cosLat;
  const c4 = c3 * cosLat;
  const c5 = c4 * cosLat;
  const c6 = c5 * cosLat;
  const c7 = c6 * cosLat;

  const m = meridianDistance(latR);
  const mOrigin = meridianDistance(rad(ORIGIN_LAT));

  const nTerm1 = (w2 / 2) * v * sinLat * cosLat;
  const nTerm2 = (w4 / 24) * v * sinLat * c3 * (4 * psi2 + psi - t2);
  const nTerm3 = (w6 / 720) * v * sinLat * c5 *
    (8 * psi4 * (11 - 24 * t2) - 28 * psi3 * (1 - 6 * t2) +
      psi2 * (1 - 32 * t2) - psi * 2 * t2 + t4);
  const nTerm4 = (w8 / 40320) * v * sinLat * c7 * (1385 - 3111 * t2 + 543 * t4 - t6);

  const N = FALSE_NORTHING + K * (m - mOrigin + nTerm1 + nTerm2 + nTerm3 + nTerm4);

  const eTerm1 = (w2 / 6) * c2 * (psi - t2);
  const eTerm2 = (w4 / 120) * c4 *
    (4 * psi3 * (1 - 6 * t2) + psi2 * (1 + 8 * t2) - psi * 2 * t2 + t4);
  const eTerm3 = (w6 / 5040) * c6 * (61 - 479 * t2 + 179 * t4 - t6);

  const E = FALSE_EASTING + K * v * w * cosLat * (1 + eTerm1 + eTerm2 + eTerm3);

  return { E, N };
}

/**
 * SVY21 easting/northing back to WGS84 longitude/latitude.
 * Used to report where a model actually sits, and to cross-check the
 * latitude and longitude an IfcSite declares for itself.
 */
export function svy21ToLonLat(E, N) {
  const Nprime = N - FALSE_NORTHING;
  const mOrigin = meridianDistance(rad(ORIGIN_LAT));
  const mPrime = mOrigin + Nprime / K;
  const sigma = (mPrime / G) * (Math.PI / 180);

  // Foot-point latitude.
  const latP = sigma +
    (3 * N_ / 2 - 27 * N3 / 32) * Math.sin(2 * sigma) +
    (21 * N2 / 16 - 55 * N4 / 32) * Math.sin(4 * sigma) +
    (151 * N3 / 96) * Math.sin(6 * sigma) +
    (1097 * N4 / 512) * Math.sin(8 * sigma);

  const sinLatP = Math.sin(latP);
  const sin2 = sinLatP * sinLatP;
  const rhoP = (A * (1 - E2)) / Math.pow(1 - E2 * sin2, 1.5);
  const vP = A / Math.sqrt(1 - E2 * sin2);
  const psiP = vP / rhoP;
  const psiP2 = psiP * psiP;
  const psiP3 = psiP2 * psiP;
  const psiP4 = psiP3 * psiP;
  const tP = Math.tan(latP);
  const tP2 = tP * tP;
  const tP4 = tP2 * tP2;
  const tP6 = tP4 * tP2;

  const x = (E - FALSE_EASTING) / (K * vP);
  const x3 = x * x * x;
  const x5 = x3 * x * x;
  const x7 = x5 * x * x;

  const latTerm1 = (tP / (K * rhoP)) * ((E - FALSE_EASTING) * x / 2);
  const latTerm2 = (tP / (K * rhoP)) * ((E - FALSE_EASTING) * x3 / 24) *
    (-4 * psiP2 + 9 * psiP * (1 - tP2) + 12 * tP2);
  const latTerm3 = (tP / (K * rhoP)) * ((E - FALSE_EASTING) * x5 / 720) *
    (8 * psiP4 * (11 - 24 * tP2) - 12 * psiP3 * (21 - 71 * tP2) +
      15 * psiP2 * (15 - 98 * tP2 + 15 * tP4) +
      180 * psiP * (5 * tP2 - 3 * tP4) + 360 * tP4);
  const latTerm4 = (tP / (K * rhoP)) * ((E - FALSE_EASTING) * x7 / 40320) *
    (1385 + 3633 * tP2 + 4095 * tP4 + 1575 * tP6);

  const lat = latP - latTerm1 + latTerm2 - latTerm3 + latTerm4;

  const secLat = 1 / Math.cos(lat);
  const lonTerm1 = x * secLat;
  const lonTerm2 = (x3 / 6) * secLat * (psiP + 2 * tP2);
  const lonTerm3 = (x5 / 120) * secLat *
    (-4 * psiP3 * (1 - 6 * tP2) + psiP2 * (9 - 68 * tP2) +
      72 * psiP * tP2 + 24 * tP4);
  const lonTerm4 = (x7 / 5040) * secLat * (61 + 662 * tP2 + 1320 * tP4 + 720 * tP6);

  const lon = rad(ORIGIN_LON) + lonTerm1 - lonTerm2 + lonTerm3 - lonTerm4;

  return { lon: deg(lon), lat: deg(lat) };
}

/**
 * The bounds SVY21 is defined over, as the URA checker states them.
 * A coordinate outside these is not a Singapore survey coordinate, which is the
 * quickest way to catch a model georeferenced into the sea or left at the origin.
 */
export const SVY21_BOUNDS = { minE: 0, maxE: 60000, minN: 20000, maxN: 50000 };

export function withinSvy21Bounds(E, N) {
  return E >= SVY21_BOUNDS.minE && E <= SVY21_BOUNDS.maxE &&
    N >= SVY21_BOUNDS.minN && N <= SVY21_BOUNDS.maxN;
}

/** Formats an IFC compound-angle array (deg, min, sec, millionths) as degrees. */
export function compoundAngleToDegrees(parts) {
  if (!Array.isArray(parts) || !parts.length) return null;
  const n = parts.map((p) => (p && typeof p === 'object' && 'value' in p ? p.value : p));
  const [d = 0, m = 0, s = 0, us = 0] = n.map(Number);
  const sign = d < 0 || m < 0 || s < 0 || us < 0 ? -1 : 1;
  return sign * (Math.abs(d) + Math.abs(m) / 60 +
    (Math.abs(s) + Math.abs(us) / 1e6) / 3600);
}
