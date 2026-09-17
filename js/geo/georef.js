/**
 * The bridge between the 3D scene and real-world SVY21 coordinates.
 *
 * Getting this wrong is silent — a model lands in the sea, or a thousand times
 * too far out, and every number downstream is confidently incorrect. So the
 * pipeline is written out in full here, and each step was verified against a
 * real Revit-exported IFC rather than inferred from the schema.
 *
 * From a scene point back to a survey coordinate:
 *
 *  1. **Undo the viewer's re-centring.** web-ifc shifts the first model to the
 *     origin so that float32 vertices keep millimetre precision at Singapore's
 *     survey coordinates. `GetCoordinationMatrix` returns the shift it used.
 *
 *  2. **Undo the axis swap.** web-ifc hands three.js a Y-up scene, while IFC is
 *     Z-up. The mapping is `scene = (x, z, -y)`, so `y = -scene.z` — the sign is
 *     the part that is easy to lose, and it mirrors the model about north.
 *
 *  3. **Apply the map conversion.** `IfcMapConversion` gives an offset, a
 *     rotation and a scale from project coordinates onto the projected CRS.
 *
 * The subtle step is the scale. `Scale` converts *project units* to *map units*,
 * and a Revit export in millimetres onto a metre-based CRS carries 0.001. But
 * web-ifc has already converted the geometry to metres, so applying 0.001 again
 * shrinks the model by a thousand. The effective scale is therefore
 * `Scale / metresPerUnit`, which for that common case is exactly 1.
 */

import * as THREE from 'three';
import { svy21ToLonLat, withinSvy21Bounds } from './svy21.js';

/**
 * @typedef {object} GeoTransform
 * @property {boolean} ok
 * @property {string} [reason]     why a transform could not be built
 * @property {(v: THREE.Vector3) => {E:number, N:number, H:number}} sceneToSvy21
 * @property {(E:number, N:number, H:number) => THREE.Vector3} svy21ToScene
 * @property {number} effectiveScale
 * @property {number} rotationDeg
 */

/**
 * @param {object} georef  from ifc-index.js readGeoreference
 * @param {THREE.Matrix4|null} coordinationMatrix  the viewer's shared datum
 * @returns {GeoTransform}
 */
export function buildTransform(georef, coordinationMatrix) {
  if (!georef || !georef.mapConversion) {
    return {
      ok: false,
      reason: 'The model carries no IfcMapConversion, so there is no defined ' +
        'relationship between its coordinates and the real world.',
    };
  }

  const mc = georef.mapConversion;
  const metresPerUnit = georef.metresPerUnit || 1;

  // See the note above: web-ifc has already applied the project's length unit,
  // so the declared scale must be divided by it rather than used as given.
  const effectiveScale = (mc.scale || 1) / metresPerUnit;

  if (!Number.isFinite(effectiveScale) || effectiveScale === 0) {
    return { ok: false, reason: 'The map conversion declares a scale that cannot be used.' };
  }

  const M = coordinationMatrix ? coordinationMatrix.clone() : new THREE.Matrix4();
  const Minv = M.clone().invert();
  const cos = Math.cos(mc.rotation);
  const sin = Math.sin(mc.rotation);

  const scratch = new THREE.Vector3();

  function sceneToSvy21(v) {
    // 1. undo re-centring, 2. undo the Y-up axis swap
    scratch.copy(v).applyMatrix4(Minv);
    const x = scratch.x;
    const y = -scratch.z;
    const z = scratch.y;
    // 3. map conversion, in metres throughout
    return {
      E: mc.eastings + effectiveScale * (x * cos - y * sin),
      N: mc.northings + effectiveScale * (x * sin + y * cos),
      H: mc.orthogonalHeight + effectiveScale * z,
    };
  }

  function svy21ToScene(E, N, H = 0) {
    const dE = (E - mc.eastings) / effectiveScale;
    const dN = (N - mc.northings) / effectiveScale;
    const z = (H - mc.orthogonalHeight) / effectiveScale;
    // Inverse rotation, then back into the scene's Y-up frame.
    const x = dE * cos + dN * sin;
    const y = -dE * sin + dN * cos;
    return new THREE.Vector3(x, z, -y).applyMatrix4(M);
  }

  return {
    ok: true,
    sceneToSvy21,
    svy21ToScene,
    effectiveScale,
    rotationDeg: (mc.rotation * 180) / Math.PI,
  };
}

/**
 * Describes what the model says about where it is, for the check's report.
 * Pure description — no judgement, so the check decides what passes.
 */
export function describeGeoreference(georef, transform) {
  const out = {
    hasMapConversion: !!(georef && georef.mapConversion),
    crsName: georef && georef.crs ? georef.crs.name : null,
    datum: georef && georef.crs ? georef.crs.geodeticDatum : null,
    lengthUnit: georef ? georef.lengthUnitName : null,
    effectiveScale: transform && transform.ok ? transform.effectiveScale : null,
    rotationDeg: transform && transform.ok ? transform.rotationDeg : null,
    isSvy21: false,
  };
  // The CRS is named freely, so match on the parts that are stable: the EPSG
  // code, or the scheme's name.
  const text = [out.crsName, out.datum, georef && georef.crs && georef.crs.mapProjection]
    .filter(Boolean).join(' ').toUpperCase();
  out.isSvy21 = /3414|SVY21|SVY 21/.test(text);
  return out;
}

/** True when a projected point is a plausible Singapore survey coordinate. */
export { withinSvy21Bounds, svy21ToLonLat };
