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

    // A second camera for plan views: true orthographic, straight down, so a
    // "plan" is an accurate flat projection rather than a steep perspective shot.
    this.orthoCamera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 5000);
    this.activeCamera = this.camera;
    this._orthoHalfHeight = 10;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    // Left button pans, right button orbits — right stays free of drag-panning
    // so it reads naturally alongside its other job, opening the context menu.
    const mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.mouseButtons = { ...mouseButtons };

    // Locked to top-down: no orbit, just pan/zoom, so plan mode can't be tilted
    // into a perspective view by accident.
    this.controlsOrtho = new OrbitControls(this.orthoCamera, this.renderer.domElement);
    this.controlsOrtho.enableDamping = true;
    this.controlsOrtho.dampingFactor = 0.08;
    this.controlsOrtho.enableRotate = false;
    this.controlsOrtho.screenSpacePanning = true;
    this.controlsOrtho.enabled = false;
    this.controlsOrtho.mouseButtons = { ...mouseButtons };

    // Section cuts (vertical, user-drawn) and the plan level cut (horizontal),
    // combined into one clipping-plane list on the renderer.
    this.sectionPlanes = [];   // [{ id, plane, normal, a, b, mid, group }]
    this._sectionSeq = 0;
    this.planClipPlane = null; // THREE.Plane | null
    this.groundY = 0;

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

    // Both mouse buttons now drive a camera drag (left pans, right orbits), so
    // a click/contextmenu firing on release of a drag would otherwise pick an
    // element or pop the menu at wherever the drag happened to end. Track each
    // button's mousedown point and ignore the follow-up if it moved.
    this._downPos = {};
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      this._downPos[e.button] = { x: e.clientX, y: e.clientY };
    });

    this.renderer.domElement.addEventListener('click', (e) => {
      if (this._wasDrag(0, e)) return;
      this.pickListeners.forEach((cb) => cb(this._pickAt(e)));
    });
    this.renderer.domElement.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this._wasDrag(2, e)) return;
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
    this._applyOrthoFrustum();
    this.renderer.setSize(w, h);
  }

  _applyOrthoFrustum() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const aspect = w / h;
    const halfH = this._orthoHalfHeight || 10;
    this.orthoCamera.left = -halfH * aspect;
    this.orthoCamera.right = halfH * aspect;
    this.orthoCamera.top = halfH;
    this.orthoCamera.bottom = -halfH;
    this.orthoCamera.updateProjectionMatrix();
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    this.controls.update();
    this.controlsOrtho.update();
    this.renderer.render(this.scene, this.activeCamera);
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

  /** Union box of everything currently visible, or null if nothing is. */
  _visibleBox() {
    const box = new THREE.Box3();
    let any = false;
    for (const entry of this.models.values()) {
      if (!entry.visible) continue;
      box.union(new THREE.Box3().setFromObject(entry.mesh));
      any = true;
    }
    return any && !box.isEmpty() ? box : null;
  }

  fit() {
    if (this.activeCamera === this.orthoCamera) {
      this.enterPlanView();
      return;
    }

    const box = this._visibleBox();
    if (!box) return;

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
    this.groundY = box.min.y;
  }

  /** Enable/disable whichever OrbitControls belongs to the active camera. */
  setOrbitEnabled(on) {
    this.controls.enabled = on && this.activeCamera === this.camera;
    this.controlsOrtho.enabled = on && this.activeCamera === this.orthoCamera;
  }

  // -------------------------------------------------------------- plan views

  /** Switches to a straight-down orthographic camera framed on the model. */
  enterPlanView() {
    const box = this._visibleBox();
    if (!box) return false;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const halfH = (Math.max(size.x, size.z) / 2) * 1.08 || 10;
    this._orthoHalfHeight = halfH;
    this._applyOrthoFrustum();

    const above = Math.max(size.y, 10) + 20;
    this.orthoCamera.position.set(center.x, box.max.y + above, center.z);
    this.orthoCamera.up.set(0, 0, -1);
    this.orthoCamera.lookAt(center.x, box.min.y, center.z);
    this.orthoCamera.near = 0.1;
    this.orthoCamera.far = size.y + above + 100;
    this.orthoCamera.updateProjectionMatrix();

    this.controlsOrtho.target.set(center.x, box.min.y, center.z);
    this.controlsOrtho.update();

    this.activeCamera = this.orthoCamera;
    this.controls.enabled = false;
    this.controlsOrtho.enabled = true;
    this.groundY = box.min.y;
    return true;
  }

  exitPlanView() {
    this.activeCamera = this.camera;
    this.controlsOrtho.enabled = false;
    this.controls.enabled = true;
  }

  /** Horizontal clip plane: keeps geometry at or below `y`, hides above. */
  setPlanClip(y) {
    this.planClipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), y);
    this._updateClipping();
  }

  clearPlanClip() {
    this.planClipPlane = null;
    this._updateClipping();
  }

  /**
   * The world-Y bounding box of one element, read straight from the rendered
   * mesh (position buffer + the pristine index cache), so it needs neither the
   * wasm model (already released by the time this is useful) nor any placement
   * math of our own — whatever the mesh actually shows is the ground truth.
   */
  elementYRange(modelID, expressID) {
    const entry = this.models.get(modelID);
    if (!entry) return null;
    const items = this._itemsMap(modelID);
    if (!items) return null;
    const byMaterial = items.map.get(expressID);
    if (!byMaterial) return null;

    const pos = entry.mesh.geometry.attributes.position;
    const idx = items.indexCache;
    let min = Infinity, max = -Infinity;
    for (const ranges of Object.values(byMaterial)) {
      for (let p = 0; p < ranges.length; p += 2) {
        for (let j = ranges[p]; j <= ranges[p + 1]; j++) {
          const y = pos.getY(idx[j]);
          if (y < min) min = y;
          if (y > max) max = y;
        }
      }
    }
    return isFinite(min) ? { min, max } : null;
  }

  /**
   * Median base height of a set of elements, e.g. everything on one storey —
   * used as that storey's floor reference for a plan cut. Sampling (rather than
   * every element) keeps this cheap on a storey with thousands of elements, and
   * the median shrugs off the odd multi-storey column or shaft.
   */
  sampleFloorY(elements, max = 60) {
    if (!elements || !elements.length) return null;
    const step = Math.max(1, Math.floor(elements.length / max));
    const mins = [];
    for (let i = 0; i < elements.length; i += step) {
      const r = this.elementYRange(elements[i].modelID, elements[i].expressID);
      if (r) mins.push(r.min);
    }
    if (!mins.length) return null;
    mins.sort((a, b) => a - b);
    return mins[Math.floor(mins.length / 2)];
  }

  // ------------------------------------------------------------ section cuts

  /**
   * Adds a vertical cutting plane through two ground points, keeping the half
   * that contains `cameraPos` (flip it afterwards with `flipSectionPlane`).
   */
  addSectionPlane(a, b, cameraPos) {
    const dir = new THREE.Vector3().subVectors(b, a);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) return null;
    dir.normalize();

    const normal = new THREE.Vector3(-dir.z, 0, dir.x);
    const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const toCam = new THREE.Vector3().subVectors(cameraPos, mid);
    if (normal.dot(toCam) < 0) normal.negate();

    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, mid);
    const id = ++this._sectionSeq;
    const entry = { id, plane, normal, a: a.clone(), b: b.clone(), mid, group: null };
    entry.group = this._buildSectionHelper(entry);
    this.scene.add(entry.group);
    this.sectionPlanes.push(entry);
    this._updateClipping();
    return id;
  }

  flipSectionPlane(id) {
    const s = this.sectionPlanes.find((x) => x.id === id);
    if (!s) return;
    s.normal.negate();
    s.plane.setFromNormalAndCoplanarPoint(s.normal, s.mid);
    this.scene.remove(s.group);
    s.group = this._buildSectionHelper(s);
    this.scene.add(s.group);
    this._updateClipping();
  }

  removeSectionPlane(id) {
    const i = this.sectionPlanes.findIndex((x) => x.id === id);
    if (i < 0) return;
    this.scene.remove(this.sectionPlanes[i].group);
    this.sectionPlanes.splice(i, 1);
    this._updateClipping();
  }

  clearSectionPlanes() {
    for (const s of this.sectionPlanes) this.scene.remove(s.group);
    this.sectionPlanes = [];
    this._updateClipping();
  }

  _updateClipping() {
    const planes = this.sectionPlanes.map((s) => s.plane);
    if (this.planClipPlane) planes.push(this.planClipPlane);
    this.renderer.clippingPlanes = planes;
  }

  /** The cut line on the ground plus an arrow pointing into the kept half. */
  _buildSectionHelper({ a, b, mid, normal }) {
    const group = new THREE.Group();
    const y = this.groundY;
    const pa = new THREE.Vector3(a.x, y, a.z);
    const pb = new THREE.Vector3(b.x, y, b.z);

    const geo = new THREE.BufferGeometry().setFromPoints([pa, pb]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffcf5c, depthTest: false }));
    line.renderOrder = 999;
    group.add(line);

    const len = pa.distanceTo(pb) || 1;
    const arrow = new THREE.ArrowHelper(
      normal.clone(), new THREE.Vector3(mid.x, y, mid.z),
      Math.max(len * 0.18, 0.6), 0xffcf5c, Math.max(len * 0.06, 0.25), Math.max(len * 0.04, 0.18));
    arrow.line.material.depthTest = false;
    arrow.cone.material.depthTest = false;
    arrow.renderOrder = 999;
    group.add(arrow);

    return group;
  }

  /** Ray-casts the pointer against loaded geometry, falling back to the ground plane. */
  raycastGround(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.activeCamera);

    const targets = [];
    for (const entry of this.models.values()) if (entry.visible) targets.push(entry.mesh);
    const hits = ray.intersectObjects(targets, true).filter((h) => h.object.visible);
    if (hits.length) return hits[0].point.clone();

    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.groundY);
    const pt = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, pt) ? pt : null;
  }

  // ----------------------------------------------------------------- picking

  onPick(cb) { this.pickListeners.push(cb); }
  onContextMenu(cb) { this.menuListeners.push(cb); }

  /** True if `button` moved more than a few px between its mousedown and `e`. */
  _wasDrag(button, e) {
    const start = this._downPos[button];
    if (!start) return false;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    return dx * dx + dy * dy > 25;
  }

  /** @returns {{modelID:number, expressID:number}|null} */
  _pickAt(event) {
    if (!this.hasModels) return null;

    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.activeCamera);

    // Overlay subsets live on the scene, not under a model, so both have to be
    // offered to the raycaster or picking would stop working during a query.
    const targets = [];
    for (const entry of this.models.values()) if (entry.visible) targets.push(entry.mesh);
    for (const o of this.overlays) if (o.mesh) targets.push(o.mesh);

    const hits = this.raycaster.intersectObjects(targets, true).filter((h) => h.object.visible);
    if (!hits.length) return null;

    // The raycaster sees the full, unclipped geometry, so the nearest hit can be
    // something a section or plan cut is actually hiding (e.g. the roof, from
    // above a plan cut) — skip past anything on the discarded side of any
    // active clipping plane to the first hit the renderer would actually draw.
    const planes = this.renderer.clippingPlanes;
    const hit = planes && planes.length
      ? hits.find((h) => planes.every((p) => p.distanceToPoint(h.point) >= 0))
      : hits[0];
    if (!hit) return null;

    try {
      const expressID = this.loader.ifcManager.getExpressId(hit.object.geometry, hit.faceIndex);
      if (expressID === undefined || expressID === null) return null;
      return { modelID: hit.object.modelID, expressID };
    } catch {
      return null;
    }
  }
}
