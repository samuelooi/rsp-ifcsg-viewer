/**
 * Three.js viewer: multi-model loading, element visibility, and the isolate /
 * colour overlays the IFC-SG queries drive.
 *
 * Two independent mechanisms are at work, and they deliberately do not overlap:
 *
 *  - **Colouring** uses web-ifc-three "subsets" — extra meshes that reuse the
 *    model's vertex buffers but index only the chosen elements. Subsets read
 *    from a pristine index cache, so they are unaffected by the hiding below.
 *
 *  - **Hiding** rewrites the base mesh's own index buffer, collapsing a hidden
 *    element's triangles to degenerate (zero-area) ones that the GPU discards.
 *    That costs only the hidden elements' indices, so hiding stays instant even
 *    on a large model, and the base mesh stays a single draw call.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { IFCLoader } from 'web-ifc-three/IFCLoader';
import { convexHull } from './geo/polygon.js';

const WASM_PATH = 'https://unpkg.com/web-ifc@0.0.36/';

/**
 * Store vertex normals as signed bytes instead of floats.
 *
 * web-ifc emits three float32 per vertex for normals, which on a large model is
 * the single biggest buffer in the scene (357 MB on a 71 MB IFC). A unit normal
 * needs nowhere near that range: signed-byte normals cost a quarter as much and
 * are accurate to about half a degree, which is not visible on flat-shaded
 * building geometry. Set this to false if shading ever looks wrong.
 */
const COMPRESS_NORMALS = true;

/**
 * Rewrites a geometry's float32 normals as signed bytes, flagged `normalized`
 * so WebGL maps them back to [-1, 1] in the shader. Returns the bytes saved.
 */
export function compressNormals(geometry) {
  const src = geometry && geometry.attributes && geometry.attributes.normal;
  if (!src || src.array instanceof Int8Array) return 0;

  const from = src.array;
  const packed = new Int8Array(from.length);
  for (let i = 0; i < from.length; i++) {
    const v = from[i];
    // Clamp before scaling: web-ifc normals are unit length, but a denormal or
    // NaN would otherwise wrap around in the byte conversion.
    packed[i] = v >= 1 ? 127 : v <= -1 ? -127 : Math.round((v || 0) * 127);
  }

  geometry.setAttribute('normal', new THREE.BufferAttribute(packed, 3, true));
  return from.byteLength - packed.byteLength;
}

export class Viewer {
  constructor(container) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1e23);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    this.camera.position.set(18, 14, 18);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    this.scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x1a1c20, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(20, 30, 10);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-20, 10, -15);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(60, 60, 0x343a42, 0x2a2e35);
    this.scene.add(this.grid);

    this.loader = new IFCLoader();
    this.loader.ifcManager.setWasmPath(WASM_PATH);

    /**
     * The shared datum for federated models, adopted from the first file loaded.
     *
     * IFC files in a set are authored against a common survey origin, often far
     * from (0,0,0). web-ifc's COORDINATE_TO_ORIGIN shifts a model to the origin
     * using a transform derived from *that file alone*, which is right for a
     * single model and wrong for a federation — each file gets a different
     * shift and their relative placement is destroyed. So the first model is
     * re-centred normally, its transform is captured here, and every later model
     * is loaded with that same transform and no re-centring of its own.
     *
     * Applying it inside web-ifc (rather than moving the mesh afterwards) means
     * vertices are generated already near the origin, which matters because
     * web-ifc returns them as float32.
     */
    this.coordinationMatrix = null;

    /** modelID -> { modelID, name, mesh, baseMaterials, ghostMaterials, visible } */
    this.models = new Map();

    /** modelID -> Set<expressID> the user has hidden. */
    this.hiddenByModel = new Map();

    this.groups = [];            // [{ elements, colour }] from the active query
    this.overlays = [];          // created subsets, tracked for exact teardown
    this.surveyOverlays = [];    // cadastral / site-boundary polygons, see setSurveyOverlays
    this.contextMode = 'ghost';  // how un-selected geometry is drawn during a query
    this.hiddenVersion = 0;      // bumped on every visibility change, see _applyHidden
    this.wireframe = false;

    this.pickListeners = [];
    this.menuListeners = [];

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this.renderer.domElement.addEventListener('click', (e) => {
      this.pickListeners.forEach((cb) => cb(this._pickAt(e)));
    });
    this.renderer.domElement.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const hit = this._pickAt(e);
      this.menuListeners.forEach((cb) => cb(hit, e.clientX, e.clientY));
    });

    window.addEventListener('resize', () => this.resize());
    this.resize();
    this._animate();
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------ model loading

  get hasModels() {
    return this.models.size > 0;
  }

  get entries() {
    return [...this.models.values()];
  }

  /** Loads an IFC file and adds it alongside anything already open. */
  async load(file, onProgress = () => {}) {
    const url = URL.createObjectURL(file);
    try {
      this.loader.ifcManager.setOnProgress((e) => {
        onProgress(e.total ? (e.loaded / e.total) * 100 : 40);
      });

      // See `coordinationMatrix`: the first model establishes the datum, every
      // later model is placed against it instead of being re-centred on itself.
      const isFirst = !this.coordinationMatrix;
      await this.loader.ifcManager.applyWebIfcConfig({
        COORDINATE_TO_ORIGIN: isFirst,
        USE_FAST_BOOLS: true,
      });
      if (isFirst) this.loader.ifcManager.clearCoordinationMatrix();
      else this.loader.ifcManager.setupCoordinationMatrix(this.coordinationMatrix);

      const mesh = await this.loader.loadAsync(url);

      // Before any subset exists, so subsets (which share this attribute by
      // reference) pick up the compressed version automatically.
      if (COMPRESS_NORMALS) compressNormals(mesh.geometry);

      const baseMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const ghostMaterials = baseMaterials.map((m) => {
        const g = m.clone();
        g.transparent = true;
        g.opacity = 0.07;
        g.depthWrite = false;
        return g;
      });
      if (this.wireframe) [...baseMaterials, ...ghostMaterials].forEach((m) => { m.wireframe = true; });

      // web-ifc-three stamps the mesh from its own counter, but everything that
      // matters (subsets, close, the property API) is keyed by web-ifc's model
      // handle. They only coincide while every load succeeds, so resolve the
      // real handle rather than trusting the counter.
      const modelID = this._resolveModelID(mesh);
      mesh.modelID = modelID;

      // web-ifc only computes the coordination matrix while streaming geometry,
      // so it has to be read after the load completes, not right after opening.
      if (isFirst) {
        try {
          const m = this.api.GetCoordinationMatrix(modelID);
          if (m && m.length === 16 && Array.from(m).every(Number.isFinite)) {
            this.coordinationMatrix = new THREE.Matrix4().fromArray(Array.from(m));
          }
        } catch { /* no geometry to derive a datum from; later models keep world coords */ }
      }

      const entry = {
        modelID,
        name: file.name,
        // Kept because CORENET X caps each submitted file, and the source file
        // is gone by the time a check runs.
        bytes: file.size || 0,
        mesh,
        baseMaterials,
        ghostMaterials,
        visible: true,
        appliedHiddenVersion: -1,
        everHidden: false,
        released: false,
      };
      this.scene.add(mesh);
      this.models.set(entry.modelID, entry);
      this.refresh();
      return entry;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Frees the parsed IFC held in the wasm heap, keeping the rendered mesh.
   *
   * Call once the property index has been built. Everything the viewer does
   * afterwards — colour subsets, picking, hiding — runs off the three.js
   * geometry and the index map, so nothing reads the wasm model again. On a
   * 71 MB file this returns ~126 MB per model, which is what makes loading
   * several files at once affordable.
   *
   * The trade-off: any *new* property read (getItemProperties and friends) is
   * no longer possible for this model. Everything the mapping needs is already
   * captured in the index by then.
   */
  releaseModelData(modelID) {
    const entry = this.models.get(modelID);
    if (!entry || entry.released) return;
    try {
      this.api.CloseModel(modelID);
      entry.released = true;
    } catch {
      /* already closed, or the model never opened cleanly */
    }
  }

  removeModel(modelID) {
    const entry = this.models.get(modelID);
    if (!entry) return;
    this._clearOverlays();
    this.models.delete(modelID);
    this.hiddenByModel.delete(modelID);

    if (entry.released) {
      // ifcManager.close would call CloseModel a second time; that throws, and
      // its catch-all would then skip disposing the mesh. Tear down directly.
      this.scene.remove(entry.mesh);
      entry.mesh.geometry?.dispose();
      entry.baseMaterials.forEach((m) => m.dispose());
      delete this.loader.ifcManager.state.models[modelID];
    } else {
      try {
        this.loader.ifcManager.close(modelID, this.scene);
      } catch {
        this.scene.remove(entry.mesh);
      }
    }

    // close() does not touch this, and it holds a full copy of the index buffer
    // (~147 MB on a large model), so drop it explicitly.
    delete this.loader.ifcManager.subsets.items.map[modelID];

    entry.ghostMaterials.forEach((m) => m.dispose());
    // Keep the datum while anything is still open so the remaining models do not
    // move; drop it once the scene is empty, so an unrelated project loaded next
    // establishes its own origin instead of inheriting this one.
    if (!this.models.size) this.coordinationMatrix = null;
    this.refresh();
  }

  setModelVisible(modelID, on) {
    const entry = this.models.get(modelID);
    if (!entry) return;
    entry.visible = on;
    this.refresh();
  }

  /** The raw web-ifc API, for the property index. */
  get api() {
    return this.loader.ifcManager.state.api;
  }

  // ------------------------------------------------------------------ memory

  /**
   * Bytes held in vertex and index buffers across every loaded model, its
   * overlay subsets, and web-ifc-three's per-model index caches.
   *
   * Subsets share the base mesh's position, normal and expressID attributes by
   * reference and only own their index, so attributes are counted once each.
   */
  geometryBytes() {
    const seen = new Set();
    let bytes = 0;
    const count = (attr) => {
      if (!attr || !attr.array || seen.has(attr)) return;
      seen.add(attr);
      bytes += attr.array.byteLength;
    };
    const countGeometry = (geometry) => {
      if (!geometry) return;
      for (const attr of Object.values(geometry.attributes)) count(attr);
      count(geometry.index);
    };

    for (const entry of this.models.values()) countGeometry(entry.mesh.geometry);
    for (const o of this.overlays) if (o.mesh) countGeometry(o.mesh.geometry);

    // The pristine index copy kept for hiding and subsets, per model.
    const maps = this.loader.ifcManager.subsets.items.map || {};
    for (const m of Object.values(maps)) {
      if (m && m.indexCache) bytes += m.indexCache.byteLength;
    }
    return bytes;
  }

  /**
   * Size of the web-ifc wasm heap. It grows to fit the largest file parsed and
   * is never returned to the browser, so this is a floor for the session.
   */
  wasmHeapBytes() {
    try {
      const mod = this.api && this.api.wasmModule;
      const heap = mod && (mod.HEAPU8 || mod.HEAP8);
      return heap ? heap.byteLength : 0;
    } catch {
      return 0;
    }
  }

  /** The web-ifc model handle backing a loaded mesh, found by identity. */
  _resolveModelID(mesh) {
    const models = this.loader.ifcManager.state.models;
    for (const k of Object.keys(models)) {
      if (models[k] && models[k].mesh === mesh) return Number(k);
    }
    return mesh.modelID;
  }

  /** `{ indexCache, map }` for a model: index ranges per expressID per material. */
  _itemsMap(modelID) {
    const items = this.loader.ifcManager.subsets.items;
    items.generateGeometryIndexMap(modelID);
    return items.map[modelID];
  }

  // ------------------------------------------------------------- visibility

  hiddenSet(modelID) {
    let s = this.hiddenByModel.get(modelID);
    if (!s) {
      s = new Set();
      this.hiddenByModel.set(modelID, s);
    }
    return s;
  }

  isHidden(el) {
    const s = this.hiddenByModel.get(el.modelID);
    return !!s && s.has(el.expressID);
  }

  get hiddenCount() {
    let n = 0;
    for (const s of this.hiddenByModel.values()) n += s.size;
    return n;
  }

  /**
   * Replaces the hidden set wholesale. The app decides *what* is hidden (manual
   * hides, the space toggle); the viewer only knows how to not draw it.
   * @param {Iterable<{modelID:number, expressID:number}>} elements
   */
  setHidden(elements) {
    this.hiddenByModel.clear();
    for (const el of elements) this.hiddenSet(el.modelID).add(el.expressID);
    this.hiddenVersion++;
    this.refresh();
  }

  showAll() {
    this.hiddenByModel.clear();
    this.hiddenVersion++;
    for (const entry of this.models.values()) entry.visible = true;
    this.refresh();
  }

  /**
   * Rewrites one model's index buffer so hidden elements draw nothing.
   * Restores from the pristine cache first, so this is also how elements
   * come back into view.
   */
  _applyHidden(entry) {
    // Rewriting the index means copying the whole buffer, so only do it when the
    // hidden set has actually moved since this model last had it applied.
    if (entry.appliedHiddenVersion === this.hiddenVersion) return;

    const hidden = this.hiddenByModel.get(entry.modelID);
    const nothingHidden = !hidden || hidden.size === 0;

    // Building the index map allocates a full duplicate of the index buffer
    // (~150 MB on a large model), so don't force it until this model actually
    // has something hidden. Once it does, the map stays and restores are cheap.
    if (nothingHidden && !entry.everHidden) return;

    entry.appliedHiddenVersion = this.hiddenVersion;
    if (!nothingHidden) entry.everHidden = true;

    const items = this._itemsMap(entry.modelID);
    if (!items) return;
    const index = entry.mesh.geometry.index;
    if (!index) return;

    index.array.set(items.indexCache);

    if (!nothingHidden) {
      const arr = index.array;
      for (const expressID of hidden) {
        const byMaterial = items.map.get(expressID);
        if (!byMaterial) continue;
        for (const ranges of Object.values(byMaterial)) {
          for (let p = 0; p < ranges.length; p += 2) {
            const start = ranges[p];
            const end = ranges[p + 1];
            // Collapse every triangle in the range onto a single vertex.
            const collapseTo = arr[start];
            for (let j = start; j <= end; j++) arr[j] = collapseTo;
          }
        }
      }
    }
    index.needsUpdate = true;
  }

  // --------------------------------------------------------------- overlays

  /** @param {Array<{elements: Array, colour: number}>} groups */
  setGroups(groups) {
    this.groups = groups || [];
    this.refresh();
  }

  /** Sets the overlay and the context mode together, in a single rebuild. */
  setQuery(groups, contextMode) {
    this.groups = groups || [];
    if (contextMode) this.contextMode = contextMode;
    this.refresh();
  }

  clearGroups() {
    this.groups = [];
    this.refresh();
  }

  setContextMode(mode) {
    this.contextMode = mode;
    this.refresh();
  }

  _clearOverlays() {
    for (const { modelID, material, customID } of this.overlays) {
      try {
        this.loader.ifcManager.removeSubset(modelID, material, customID);
      } catch { /* already gone */ }
      material.dispose();
    }
    this.overlays = [];
  }

  /**
   * Reconciles the scene with the current models, hidden set and query groups.
   * Cheap enough to call on every interaction.
   */
  refresh() {
    this._clearOverlays();

    const hasQuery = this.groups.length > 0;

    for (const entry of this.models.values()) {
      this._applyHidden(entry);

      if (!entry.visible) {
        entry.mesh.visible = false;
        continue;
      }

      // Colour overlays, one subset per group per model, skipping hidden members.
      this.groups.forEach((g, gi) => {
        const ids = [];
        for (const el of g.elements) {
          if (el.modelID !== entry.modelID) continue;
          if (this.isHidden(el)) continue;
          ids.push(el.expressID);
        }
        if (!ids.length) return;

        const material = new THREE.MeshLambertMaterial({
          color: new THREE.Color(g.colour),
          side: THREE.DoubleSide,
          wireframe: this.wireframe,
        });
        const customID = `ifcsg-${gi}`;
        const mesh = this.loader.ifcManager.createSubset({
          modelID: entry.modelID,
          ids,
          material,
          scene: this.scene,
          removePrevious: true,
          customID,
        });
        this.overlays.push({ modelID: entry.modelID, material, customID, mesh });
      });

      // The base mesh is the context behind the overlay. Overlay subsets are
      // parented to the scene, so hiding the base mesh does not hide them.
      if (!hasQuery) {
        entry.mesh.visible = true;
        entry.mesh.material = entry.baseMaterials;
      } else if (this.contextMode === 'ghost') {
        entry.mesh.visible = true;
        entry.mesh.material = entry.ghostMaterials;
      } else if (this.contextMode === 'normal') {
        entry.mesh.visible = true;
        entry.mesh.material = entry.baseMaterials;
      } else {
        entry.mesh.visible = false;
      }
    }
  }

  // ------------------------------------------------------- geometry sampling

  /**
   * Scene-space vertices belonging to one element.
   *
   * Reads the same per-element index ranges the hiding uses, so it works after
   * the parsed IFC has been released — there is no other way to get an
   * element's geometry once the wasm model is closed.
   *
   * @returns {THREE.Vector3[]} deduplicated, capped at `limit`
   */
  elementPoints(modelID, expressID, limit = 20000) {
    const entry = this.models.get(modelID);
    if (!entry) return [];
    const items = this._itemsMap(modelID);
    const byMaterial = items && items.map.get(expressID);
    if (!byMaterial) return [];

    const position = entry.mesh.geometry.attributes.position;
    const cache = items.indexCache;
    const seen = new Set();
    const points = [];

    for (const ranges of Object.values(byMaterial)) {
      for (let p = 0; p < ranges.length; p += 2) {
        for (let j = ranges[p]; j <= ranges[p + 1] && points.length < limit; j++) {
          const vi = cache[j];
          if (seen.has(vi)) continue;
          seen.add(vi);
          points.push(new THREE.Vector3(
            position.getX(vi), position.getY(vi), position.getZ(vi)));
        }
      }
    }
    return points;
  }

  /**
   * Ground-plane convex hull over every vertex a callback yields, as `[[x, z], …]`
   * in scene coordinates.
   *
   * **Exact, not sampled.** An earlier version sampled every fourteenth vertex,
   * which is fine for drawing and wrong for a containment test: the hull of a
   * sample is contained by the true hull, so a corner poking over a boundary can
   * be missed entirely. A check that quietly under-reports is worse than none.
   *
   * Exactness is affordable because of the prefilter. One pass finds the extreme
   * point in eight directions; those eight are genuine hull vertices, so the
   * octagon they span lies inside the true hull and every point within it is
   * provably not a hull vertex. A second pass discards those — on building
   * geometry, virtually all of them — and only the survivors are sorted.
   */
  _groundHull(iterate) {
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    const best = DIRS.map(() => ({ score: -Infinity, point: null }));

    iterate((x, z) => {
      for (let i = 0; i < 8; i++) {
        const score = DIRS[i][0] * x + DIRS[i][1] * z;
        if (score > best[i].score) {
          best[i].score = score;
          best[i].point = [x, z];
        }
      }
    });

    const extremes = best.map((b) => b.point).filter(Boolean);
    if (extremes.length < 3) return extremes;

    const octagon = convexHull(extremes);
    const candidates = extremes.slice();

    if (octagon.length >= 3) {
      // Strictly-inside test against a counter-clockwise convex polygon.
      const inside = (x, z) => {
        for (let i = 0, n = octagon.length; i < n; i++) {
          const [ax, az] = octagon[i];
          const [bx, bz] = octagon[(i + 1) % n];
          if ((bx - ax) * (z - az) - (bz - az) * (x - ax) < 0) return false;
        }
        return true;
      };
      iterate((x, z) => { if (!inside(x, z)) candidates.push([x, z]); });
    } else {
      iterate((x, z) => candidates.push([x, z]));
    }

    return convexHull(candidates);
  }

  /** Ground-plane hull of every visible model, in scene coordinates. */
  modelHull() {
    const meshes = [];
    for (const entry of this.models.values()) {
      if (entry.visible) meshes.push(entry.mesh.geometry.attributes.position);
    }
    if (!meshes.length) return [];

    return this._groundHull((cb) => {
      for (const position of meshes) {
        const arr = position.array;
        for (let i = 0, n = position.count; i < n; i++) cb(arr[i * 3], arr[i * 3 + 2]);
      }
    });
  }

  /** Ground-plane hull of specific elements, in scene coordinates. */
  elementHull(elements) {
    const perModel = new Map();
    for (const el of elements || []) {
      if (!perModel.has(el.modelID)) perModel.set(el.modelID, []);
      perModel.get(el.modelID).push(el.expressID);
    }

    const sources = [];
    for (const [modelID, ids] of perModel) {
      const entry = this.models.get(modelID);
      if (!entry) continue;
      const items = this._itemsMap(modelID);
      if (!items) continue;
      sources.push({ position: entry.mesh.geometry.attributes.position, items, ids });
    }
    if (!sources.length) return [];

    return this._groundHull((cb) => {
      for (const { position, items, ids } of sources) {
        const arr = position.array;
        const cache = items.indexCache;
        for (const expressID of ids) {
          const byMaterial = items.map.get(expressID);
          if (!byMaterial) continue;
          for (const ranges of Object.values(byMaterial)) {
            for (let p = 0; p < ranges.length; p += 2) {
              for (let j = ranges[p]; j <= ranges[p + 1]; j++) {
                const vi = cache[j];
                cb(arr[vi * 3], arr[vi * 3 + 2]);
              }
            }
          }
        }
      }
    });
  }

  /** Lowest point of the visible models, where ground-plane overlays are drawn. */
  groundLevel() {
    let min = Infinity;
    for (const entry of this.models.values()) {
      if (!entry.visible) continue;
      const g = entry.mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      if (g.boundingBox && g.boundingBox.min.y < min) min = g.boundingBox.min.y;
    }
    return Number.isFinite(min) ? min : 0;
  }

  // -------------------------------------------------------- survey overlays

  /**
   * Draws flat polygons on the ground plane — the cadastral lot and the site
   * boundary the geo-referencing check compares.
   *
   * These are not model geometry: they are drawn from survey coordinates, sit
   * outside the hiding and colouring machinery entirely, and are never picked.
   *
   * @param {Array<{points: THREE.Vector3[], colour: number, opacity?: number,
   *                fill?: boolean, elevation?: number}>} polygons
   */
  setSurveyOverlays(polygons) {
    this.clearSurveyOverlays();
    if (!polygons || !polygons.length) return;

    for (const poly of polygons) {
      const pts = poly.points || [];
      if (pts.length < 3) continue;
      const y = poly.elevation !== undefined ? poly.elevation : this.groundLevel();

      // Outline. Drawn slightly above the fill so it is never z-fought away.
      const outline = new THREE.BufferGeometry().setFromPoints(
        pts.map((p) => new THREE.Vector3(p.x, y + 0.06, p.z)));
      const lineMaterial = new THREE.LineBasicMaterial({
        color: new THREE.Color(poly.colour), depthTest: false, transparent: true,
      });
      const line = new THREE.LineLoop(outline, lineMaterial);
      line.renderOrder = 999;
      this.scene.add(line);
      this.surveyOverlays.push({ object: line, geometry: outline, material: lineMaterial });

      if (poly.fill === false) continue;

      // Fill. Triangulated properly rather than fanned, because a cadastral lot
      // is routinely concave and a fan would spill outside it.
      const contour = pts.map((p) => new THREE.Vector2(p.x, p.z));
      let faces = [];
      try {
        faces = THREE.ShapeUtils.triangulateShape(contour, []);
      } catch {
        faces = [];
      }
      if (!faces.length) continue;

      const positions = new Float32Array(faces.length * 9);
      let k = 0;
      for (const [a, b, c] of faces) {
        for (const i of [a, b, c]) {
          positions[k++] = contour[i].x;
          positions[k++] = y + 0.02;
          positions[k++] = contour[i].y;
        }
      }
      const fillGeometry = new THREE.BufferGeometry();
      fillGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const fillMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(poly.colour),
        transparent: true,
        opacity: poly.opacity === undefined ? 0.25 : poly.opacity,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(fillGeometry, fillMaterial);
      mesh.renderOrder = 998;
      this.scene.add(mesh);
      this.surveyOverlays.push({ object: mesh, geometry: fillGeometry, material: fillMaterial });
    }
  }

  clearSurveyOverlays() {
    for (const o of this.surveyOverlays) {
      this.scene.remove(o.object);
      o.geometry.dispose();
      o.material.dispose();
    }
    this.surveyOverlays = [];
  }

  get hasSurveyOverlays() {
    return this.surveyOverlays.length > 0;
  }

  /** Frames the camera on the survey overlays plus the models. */
  fitSurvey() {
    if (!this.surveyOverlays.length) return this.fit();
    const box = new THREE.Box3();
    for (const o of this.surveyOverlays) box.expandByObject(o.object);
    for (const entry of this.models.values()) {
      if (entry.visible) box.union(new THREE.Box3().setFromObject(entry.mesh));
    }
    if (box.isEmpty()) return this.fit();

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 10;
    const dist = maxDim * 1.3;
    this.camera.position.set(center.x + dist * 0.6, center.y + dist, center.z + dist * 0.6);
    this.camera.near = maxDim / 200;
    this.camera.far = maxDim * 60;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    return undefined;
  }

  reset() {
    this.groups = [];
    this.contextMode = 'ghost';
    this.clearSurveyOverlays();
    this.refresh();
  }

  setWireframe(on) {
    this.wireframe = on;
    for (const entry of this.models.values()) {
      [...entry.baseMaterials, ...entry.ghostMaterials].forEach((m) => { m.wireframe = on; });
    }
    this.overlays.forEach((o) => { o.material.wireframe = on; });
  }

  // ------------------------------------------------------------------ camera

  fit() {
    const box = new THREE.Box3();
    let any = false;
    for (const entry of this.models.values()) {
      if (!entry.visible) continue;
      box.union(new THREE.Box3().setFromObject(entry.mesh));
      any = true;
    }
    if (!any || box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 10;
    const dist = maxDim * 1.6;

    this.camera.position.set(center.x + dist, center.y + dist * 0.75, center.z + dist);
    this.camera.near = maxDim / 100;
    this.camera.far = maxDim * 50;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    this.grid.position.y = box.min.y;
  }

  // ----------------------------------------------------------------- picking

  onPick(cb) { this.pickListeners.push(cb); }
  onContextMenu(cb) { this.menuListeners.push(cb); }

  /** @returns {{modelID:number, expressID:number}|null} */
  _pickAt(event) {
    if (!this.hasModels) return null;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    // Overlay subsets live on the scene, not under a model, so both have to be
    // offered to the raycaster or picking would stop working during a query.
    const targets = [];
    for (const entry of this.models.values()) if (entry.visible) targets.push(entry.mesh);
    for (const o of this.overlays) if (o.mesh) targets.push(o.mesh);

    const hits = this.raycaster.intersectObjects(targets, true).filter((h) => h.object.visible);
    if (!hits.length) return null;

    const hit = hits[0];
    try {
      const expressID = this.loader.ifcManager.getExpressId(hit.object.geometry, hit.faceIndex);
      if (expressID === undefined || expressID === null) return null;
      return { modelID: hit.object.modelID, expressID };
    } catch {
      return null;
    }
  }
}
