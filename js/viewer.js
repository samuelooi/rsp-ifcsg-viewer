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

  reset() {
    this.groups = [];
    this.contextMode = 'ghost';
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
