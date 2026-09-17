/**
 * URA geo-referencing check.
 *
 * Reverse-engineered from the URA Revit Model Quality Checker, which asks the
 * user for the cadastral lot as GeoJSON, extracts the site boundary from the
 * model, draws both, and validates that the model is correctly georeferenced.
 *
 * The question it answers is narrow and worth stating plainly: **is this model
 * in the right place on the ground?** Not whether the building complies with
 * anything — whether the coordinates it was authored against put it inside the
 * land it is supposed to occupy.
 *
 * Three sources of truth get compared:
 *
 *  - the **cadastral lot** the user uploads, in WGS84, projected to SVY21
 *  - the **site boundary** modelled as an IfcGeographicElement/SITEBOUNDARY
 *  - the **model's own footprint**, from its geometry
 *
 * A model with no site boundary is common, so the footprint is the fallback:
 * containment can still be answered, just less precisely, and the report says
 * which of the two it used.
 */

import { buildTransform, describeGeoreference, svy21ToLonLat, withinSvy21Bounds } from '../../geo/georef.js';
import { parseCadastralGeoJson, parseVertices } from '../../geo/geojson.js';
import {
  area, centroid, bounds, simplify, signedDistanceToRing,
} from '../../geo/polygon.js';
import { SEVERITY } from '../severity.js';
import { esc } from '../../util/dom.js';

/** The URA checker's stated tolerance for the manual three-vertex test. */
const VERTEX_TOLERANCE_M = 0.02;

/**
 * How far a modelled site boundary may sit from the cadastral lot before it is
 * reported. A survey boundary and a cadastral lot are the same line on the
 * ground, so this is generous rather than lax — it is looking for a model in
 * the wrong place, not for survey-grade disagreement.
 */
const BOUNDARY_TOLERANCE_M = 1.0;

const LOT_COLOUR = 0x4fbf6a;        // green, as the URA plugin draws it
const BOUNDARY_COLOUR = 0x4f8fd1;   // blue, likewise
const FOOTPRINT_COLOUR = 0xe0a458;  // amber: ours, not the authority's

const metres = (n) => (Math.abs(n) < 1 ? (n * 1000).toFixed(0) + ' mm' : n.toFixed(2) + ' m');

/** Every element that declares itself a site boundary, per the URA plugin's rule. */
function findSiteBoundaries(index) {
  const pool = index.byEntity.get('IFCGEOGRAPHICELEMENT') || [];
  return pool.filter((el) => {
    const t = String(el.objectType || el.predefinedType || '').toUpperCase().replace(/[^A-Z]/g, '');
    return t.includes('SITEBOUNDARY');
  });
}

/** @type {import('../types.js').CheckModule} */
const module = {
  run(ctx) {
    const findings = [];
    const add = (severity, code, label, message, extra = {}) =>
      findings.push({ severity, code, label, message, rule: 'URA geo-referencing', ...extra });

    let assertions = 0;
    let pass = 0;
    const scored = (ok, severity, code, label, message, extra) => {
      assertions++;
      if (ok) {
        pass++;
        add(SEVERITY.PASS, code, label, message, extra);
      } else {
        add(severity, code, label, message, extra);
      }
      return ok;
    };

    const georef = ctx.index.georef;
    const transform = buildTransform(georef, ctx.coordinationMatrix);
    const described = describeGeoreference(georef, transform);

    const detail = {
      described,
      lots: [],
      siteBoundary: null,
      footprint: null,
      overlays: [],
      vertices: [],
      usedFallback: false,
    };

    // ---------------------------------------------------- 1. is it georeferenced
    if (!scored(transform.ok, SEVERITY.FAIL, 'not-georeferenced',
      'Model is georeferenced',
      transform.ok
        ? 'The model carries an IfcMapConversion defining its position on the ground.'
        : transform.reason)) {
      return {
        summary: { elements: 0, assertions, pass, fail: assertions - pass, elementKeys: [] },
        findings,
        detail,
        note: 'Without a map conversion nothing further can be checked — every ' +
          'other test depends on knowing where the model sits.',
      };
    }

    // ---------------------------------------------------------- 2. is it SVY21
    scored(described.isSvy21, SEVERITY.FAIL, 'wrong-crs',
      'Coordinate system is SVY21',
      described.isSvy21
        ? `The model declares ${described.crsName || 'SVY21'}, the national system URA checks against.`
        : `The model declares "${described.crsName || 'no named CRS'}". URA checks against ` +
          'SVY21 (EPSG:3414); coordinates in any other system will not line up.');

    // ------------------------------- 2b. every file agrees on where the world is
    //
    // URA requires linked files to use shared coordinates. The federated
    // equivalent is that every loaded file declares the same map conversion —
    // the first one establishes the datum the rest are drawn against, so a file
    // that disagrees is being displayed at the wrong place regardless of what
    // its own georeferencing says.
    const perModel = ctx.index.georefByModel;
    if (perModel && perModel.size > 1) {
      const signature = (g) => {
        if (!g || !g.mapConversion) return 'none';
        const m = g.mapConversion;
        return [m.eastings, m.northings, m.orthogonalHeight,
          m.rotation.toFixed(9), m.scale, (g.crs && g.crs.name) || ''].join('|');
      };
      const groups = new Map();
      for (const [modelID, g] of perModel) {
        const key = signature(g);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(ctx.modelNames.get(modelID) || `model ${modelID}`);
      }
      const consistent = groups.size === 1;
      scored(consistent, SEVERITY.FAIL, 'mixed-coordinates',
        'All files share the same coordinate reference',
        consistent
          ? `All ${perModel.size} files declare the same map conversion.`
          : `The ${perModel.size} loaded files declare ${groups.size} different map ` +
            'conversions: ' +
            [...groups.values()].map((names) => names.join(' + ')).join(' against ') +
            '. Files not on shared coordinates will not line up with each other.');
    }

    // --------------------------------- 3. model footprint, and is it in Singapore
    //
    // The hull is computed in scene space by the viewer and only its vertices
    // are projected. Scene-to-survey is an affine transform, so it maps the
    // hull of a set onto the hull of the image — hulling first loses nothing
    // and avoids projecting millions of interior vertices.
    const groundY = ctx.geometry ? ctx.geometry.groundLevel() : 0;
    const toSurvey = (hull) => hull.map(([x, z]) => {
      const s = transform.sceneToSvy21({ x, y: groundY, z });
      return [s.E, s.N];
    });

    const siteBoundaryElements = findSiteBoundaries(ctx.index);
    let footprintRing = null;
    let footprintSource = null;

    if (siteBoundaryElements.length && ctx.geometry) {
      const hull = ctx.geometry.elementHull(siteBoundaryElements);
      if (hull.length >= 3) {
        footprintRing = simplify(toSurvey(hull), 0.05);
        footprintSource = 'site boundary';
        detail.siteBoundary = {
          elements: siteBoundaryElements,
          ring: footprintRing,
          area: area(footprintRing),
        };
      }
    }

    if (!footprintRing && ctx.geometry) {
      const hull = ctx.geometry.modelHull();
      if (hull.length >= 3) {
        footprintRing = simplify(toSurvey(hull), 0.05);
        footprintSource = 'model geometry';
        detail.usedFallback = true;
      }
    }

    scored(siteBoundaryElements.length > 0, SEVERITY.WARN, 'no-site-boundary',
      'Site boundary is modelled',
      siteBoundaryElements.length
        ? `${siteBoundaryElements.length} IfcGeographicElement with ObjectType SITEBOUNDARY found.`
        : 'No IfcGeographicElement with ObjectType SITEBOUNDARY is present. The ' +
          'check falls back to the extent of the model geometry, which answers ' +
          'containment but cannot confirm the boundary itself.');

    if (!footprintRing) {
      add(SEVERITY.FAIL, 'no-geometry', 'Model extent could be determined',
        'The model has no geometry to locate, so its position cannot be checked.');
      assertions++;
      return {
        summary: { elements: 0, assertions, pass, fail: assertions - pass, elementKeys: [] },
        findings, detail,
      };
    }

    detail.footprint = { ring: footprintRing, source: footprintSource, area: area(footprintRing) };
    const centre = centroid(footprintRing);
    const bbox = bounds(footprintRing);
    detail.position = {
      centreE: centre[0],
      centreN: centre[1],
      lonLat: svy21ToLonLat(centre[0], centre[1]),
      bbox,
    };

    scored(withinSvy21Bounds(centre[0], centre[1]), SEVERITY.FAIL, 'outside-svy21',
      'Model sits within the SVY21 extent',
      withinSvy21Bounds(centre[0], centre[1])
        ? `Centre of the model is at ${centre[0].toFixed(1)} E, ${centre[1].toFixed(1)} N.`
        : `Centre of the model projects to ${centre[0].toFixed(1)} E, ${centre[1].toFixed(1)} N, ` +
          'outside the range SVY21 covers. The model is almost certainly not georeferenced ' +
          'to its real position.');

    detail.overlays.push({
      label: footprintSource === 'site boundary' ? 'Site boundary' : 'Model extent',
      ring: footprintRing,
      colour: footprintSource === 'site boundary' ? BOUNDARY_COLOUR : FOOTPRINT_COLOUR,
    });

    // -------------------------- 4. the site's own declared latitude and longitude
    if (georef.site && (georef.site.refLatitude || georef.site.refLongitude)) {
      const declared = {
        lat: compound(georef.site.refLatitude),
        lon: compound(georef.site.refLongitude),
      };
      if (declared.lat !== null && declared.lon !== null) {
        const actual = detail.position.lonLat;
        const dLat = (declared.lat - actual.lat) * 111320;
        const dLon = (declared.lon - actual.lon) * 111320 * Math.cos((actual.lat * Math.PI) / 180);
        const off = Math.hypot(dLat, dLon);
        detail.siteRef = { declared, actual, offsetM: off };
        // Informational: the mapping does not require these to agree, but a
        // large disagreement means two parts of the file tell different stories.
        scored(off < 250, SEVERITY.WARN, 'site-ref-mismatch',
          'IfcSite latitude and longitude agree with the map conversion',
          off < 250
            ? `IfcSite declares ${declared.lat.toFixed(5)}, ${declared.lon.toFixed(5)}, ` +
              `within ${metres(off)} of where the map conversion puts the model.`
            : `IfcSite declares ${declared.lat.toFixed(5)}, ${declared.lon.toFixed(5)}, but the ` +
              `map conversion puts the model at ${actual.lat.toFixed(5)}, ${actual.lon.toFixed(5)} — ` +
              `${(off / 1000).toFixed(2)} km apart. The map conversion is the one that positions ` +
              'the geometry; the reference point looks to have been left unset.');
      }
    }

    // ------------------------------------------------- 5. the cadastral lot input
    const lotInput = ctx.inputs && ctx.inputs.cadastralLot;
    if (lotInput && lotInput.text) {
      let parsed = null;
      try {
        parsed = parseCadastralGeoJson(lotInput.text);
      } catch (err) {
        add(SEVERITY.FAIL, 'bad-geojson', 'Cadastral lot could be read', err.message);
        assertions++;
      }

      if (parsed) {
        detail.lots = parsed.lots;
        detail.lotSource = lotInput.name;
        for (const w of parsed.warnings) {
          add(SEVERITY.WARN, 'geojson-warning', 'Cadastral lot file', w);
        }
        for (const lot of parsed.lots) {
          detail.overlays.push({ label: `Lot ${lot.key}`, ring: lot.ring, colour: LOT_COLOUR });
        }

        // Containment: every footprint vertex should fall inside some lot.
        let worstOutside = 0;
        let outsideCount = 0;
        for (const p of footprintRing) {
          const best = Math.min(...parsed.lots.map((l) => signedDistanceToRing(p, l.ring)));
          if (best > 0) {
            outsideCount++;
            worstOutside = Math.max(worstOutside, best);
          }
        }
        const contained = outsideCount === 0;
        detail.containment = { outsideCount, worstOutside, total: footprintRing.length };

        scored(contained, SEVERITY.FAIL, 'outside-lot',
          `${footprintSource === 'site boundary' ? 'Site boundary' : 'Model'} lies within the cadastral lot`,
          contained
            ? `All ${footprintRing.length} points of the ${footprintSource} fall inside ` +
              `lot ${parsed.lots.map((l) => l.key).join(', ')}.`
            : `${outsideCount} of ${footprintRing.length} points of the ${footprintSource} fall ` +
              `outside the cadastral lot, by up to ${metres(worstOutside)}. Either the model is ` +
              'georeferenced to the wrong position, or the wrong lot was supplied.');

        // Where a real site boundary exists, compare it to the lot line itself.
        if (detail.siteBoundary) {
          let worst = 0;
          for (const p of detail.siteBoundary.ring) {
            worst = Math.max(worst, Math.min(
              ...parsed.lots.map((l) => Math.abs(signedDistanceToRing(p, l.ring)))));
          }
          detail.boundaryDeviation = worst;
          scored(worst <= BOUNDARY_TOLERANCE_M, SEVERITY.WARN, 'boundary-deviation',
            'Site boundary follows the cadastral lot line',
            worst <= BOUNDARY_TOLERANCE_M
              ? `The modelled boundary is within ${metres(worst)} of the cadastral lot line.`
              : `The modelled boundary departs from the cadastral lot line by up to ` +
                `${metres(worst)}, against a ${BOUNDARY_TOLERANCE_M} m tolerance.`);

          const lotArea = parsed.lots.reduce((n, l) => n + area(l.ring), 0);
          detail.areaComparison = { boundary: detail.siteBoundary.area, lot: lotArea };
        }
      }
    } else {
      add(SEVERITY.INFO, 'no-lot', 'Cadastral lot not supplied',
        'Upload the cadastral lot GeoJSON to check the model against the land it sits on. ' +
        'Without it only the model\'s own georeferencing is checked.');
    }

    // ------------------------------------------ 6. the manual three-vertex fallback
    const vertexInput = ctx.inputs && ctx.inputs.vertices;
    if (vertexInput && String(vertexInput).trim()) {
      try {
        const pts = parseVertices(vertexInput);
        detail.vertices = pts;
        const reference = detail.siteBoundary ? detail.siteBoundary.ring : footprintRing;
        for (const [i, p] of pts.entries()) {
          const inRange = withinSvy21Bounds(p[0], p[1]);
          scored(inRange, SEVERITY.FAIL, 'vertex-range',
            `Vertex ${i + 1} is a valid SVY21 coordinate`,
            inRange
              ? `${p[0].toFixed(3)} E, ${p[1].toFixed(3)} N.`
              : `${p[0].toFixed(3)} E, ${p[1].toFixed(3)} N is outside the SVY21 extent ` +
                '(easting 0–60,000 m, northing 20,000–50,000 m).');
          if (!inRange) continue;

          const d = Math.abs(signedDistanceToRing(p, reference));
          scored(d <= VERTEX_TOLERANCE_M, SEVERITY.FAIL, 'vertex-offset',
            `Vertex ${i + 1} lies on the ${detail.siteBoundary ? 'site boundary' : 'model extent'}`,
            d <= VERTEX_TOLERANCE_M
              ? `Offset ${metres(d)}, within the ±20 mm tolerance.`
              : `Offset ${metres(d)}, beyond the ±20 mm tolerance. The model is not ` +
                'georeferenced to these surveyed points.');
        }
      } catch (err) {
        add(SEVERITY.FAIL, 'bad-vertices', 'Vertices could be read', err.message);
        assertions++;
      }
    }

    return {
      summary: {
        elements: siteBoundaryElements.length,
        assertions,
        pass,
        fail: assertions - pass,
        elementKeys: siteBoundaryElements.map((e) => e.key),
      },
      findings,
      detail,
      note: detail.usedFallback
        ? 'No site boundary is modelled, so containment was tested against the ' +
          'convex extent of the model geometry. That overstates a concave footprint, ' +
          'which makes the containment test conservative rather than lenient.'
        : undefined,
    };
  },

  render(result, host, actions) {
    const d = result.detail;
    const parts = [];

    const rows = [];
    if (d.described.crsName) rows.push(['Coordinate system', d.described.crsName]);
    if (d.described.lengthUnit) rows.push(['Project length unit', d.described.lengthUnit]);
    if (d.described.rotationDeg !== null && d.described.rotationDeg !== undefined) {
      rows.push(['Grid rotation', d.described.rotationDeg.toFixed(4) + '°']);
    }
    if (d.position) {
      rows.push(['Model centre', `${d.position.centreE.toFixed(1)} E, ${d.position.centreN.toFixed(1)} N`]);
      rows.push(['Longitude / latitude',
        `${d.position.lonLat.lon.toFixed(6)}, ${d.position.lonLat.lat.toFixed(6)}`]);
    }
    if (d.footprint) {
      rows.push([d.footprint.source === 'site boundary' ? 'Site boundary area' : 'Model extent area',
        Math.round(d.footprint.area).toLocaleString() + ' m²']);
    }
    if (d.lots.length) {
      rows.push(['Cadastral lot' + (d.lots.length > 1 ? 's' : ''),
        d.lots.map((l) => l.key).join(', ')]);
      rows.push(['Lot area', Math.round(d.lots.reduce((n, l) => n + area(l.ring), 0)).toLocaleString() + ' m²']);
    }
    if (d.siteRef) {
      rows.push(['IfcSite reference point',
        `${d.siteRef.declared.lat.toFixed(5)}, ${d.siteRef.declared.lon.toFixed(5)}`]);
    }

    if (rows.length) {
      parts.push('<div class="geo-facts">' + rows.map(([k, v]) =>
        `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`).join('') + '</div>');
    }

    parts.push('<div class="ilist">' + result.findings.map((f) => {
      const colour = f.severity === SEVERITY.PASS ? 'var(--ok)'
        : f.severity === SEVERITY.WARN ? 'var(--warn)'
          : f.severity === SEVERITY.INFO ? 'var(--accent)' : 'var(--danger)';
      return `<div class="irow">
        <span class="status-dot" style="background:${colour}"></span>
        <span class="ik">${esc(f.label)}<br>
          <span style="color:var(--text-dim);font-size:10.5px">${esc(f.message)}</span></span>
      </div>`;
    }).join('') + '</div>');

    if (d.overlays.length) {
      parts.push('<div class="card-actions"><button class="btn sm" data-act="draw">' +
        'Show on model</button></div>');
    }

    host.innerHTML = parts.join('');

    const draw = host.querySelector('[data-act="draw"]');
    if (draw) draw.addEventListener('click', () => actions.showSurvey(d.overlays));
  },
};

/** IFC compound angle (degrees, minutes, seconds, millionths) to decimal degrees. */
function compound(parts) {
  const raw = Array.isArray(parts) ? parts : null;
  if (!raw || !raw.length) return null;
  const n = raw.map((p) => Number(p && typeof p === 'object' && 'value' in p ? p.value : p));
  if (n.some((v) => !Number.isFinite(v))) return null;
  const [d = 0, m = 0, s = 0, us = 0] = n;
  const sign = d < 0 ? -1 : 1;
  return sign * (Math.abs(d) + Math.abs(m) / 60 + (Math.abs(s) + Math.abs(us) / 1e6) / 3600);
}

export default module;
