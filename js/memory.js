/**
 * Memory meter: estimates how much of the browser tab's headroom the loaded
 * models consume, so a user can see an oversized model coming before the tab
 * runs out of memory and crashes.
 *
 * Browsers expose very little here. `performance.memory` (Chromium only) reports
 * the JavaScript heap, but typed arrays and the wasm heap live *outside* that
 * heap, and they are where an IFC model's memory actually goes. So the estimate
 * is built from what the app itself allocates and can measure exactly:
 *
 *   geometry   every vertex / index buffer held by three.js
 *   wasm       the web-ifc heap (grows on parse, never shrinks)
 *   jsHeap     everything else, where the browser reports it
 *
 * GPU driver copies of the buffers live in a separate process and are not
 * counted; the renderer process is the one that crashes.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * Renderer headroom to measure against. There is no API for the real ceiling,
 * so this is a budget: 4 GiB is where a 64-bit Chromium tab holding large
 * typed arrays becomes unstable in practice. Override per session with
 * `?membudget=6` (GiB) when a machine is known to cope with more, or less.
 */
const DEFAULT_BUDGET = 4 * GiB;

/**
 * Bytes of memory per byte of IFC, measured on a 71 MB architectural export
 * with compressed normals (see README "Memory"): geometry buffers came to about
 * 10x the file, and the parsed wasm model a further 2x while it is indexed.
 */
const STEADY_BYTES_PER_IFC_BYTE = 10;
const PEAK_BYTES_PER_IFC_BYTE = 12;

export const LEVEL = { OK: 'ok', WARN: 'warn', DANGER: 'danger' };
const WARN_AT = 0.6;
const DANGER_AT = 0.85;

/** The budget for this session, in bytes. */
export function resolveBudget() {
  const q = Number(new URLSearchParams(location.search).get('membudget'));
  if (Number.isFinite(q) && q > 0) return q * GiB;

  let budget = DEFAULT_BUDGET;
  // Chromium reports device RAM in GiB, rounded and capped at 8. Leave half of
  // a small machine for the OS and other tabs rather than assuming the default.
  const device = navigator.deviceMemory;
  if (Number.isFinite(device) && device > 0) budget = Math.min(budget, (device * GiB) / 2);
  return budget;
}

/**
 * Snapshot of the tab's estimated memory.
 * @param {import('./viewer.js').Viewer|null} viewer
 * @returns {{ geometry:number, wasm:number, jsHeap:number|null, total:number,
 *             budget:number, ratio:number, level:string, exact:boolean }}
 */
export function measure(viewer) {
  const geometry = viewer ? viewer.geometryBytes() : 0;
  const wasm = viewer ? viewer.wasmHeapBytes() : 0;

  const perf = typeof performance !== 'undefined' ? performance.memory : undefined;
  const jsHeap = perf && Number.isFinite(perf.usedJSHeapSize) ? perf.usedJSHeapSize : null;

  const total = geometry + wasm + (jsHeap || 0);
  const budget = resolveBudget();
  const ratio = budget ? total / budget : 0;

  return {
    geometry, wasm, jsHeap, total, budget, ratio,
    level: levelFor(ratio),
    // Without the JS heap figure the estimate only covers what the app tracks.
    exact: jsHeap !== null,
  };
}

/**
 * Expected memory after loading the given files on top of the current state.
 * Used to warn *before* a parse that cannot be interrupted once it starts.
 * @param {{total:number, wasm:number, budget:number}} current  from measure()
 * @param {File[]} files
 */
export function project(current, files) {
  const bytes = files.reduce((n, f) => n + (f.size || 0), 0);
  // The wasm heap is reused between files, so only its growth counts, but each
  // file's geometry stays resident.
  const wasmNeeded = Math.max(0, (PEAK_BYTES_PER_IFC_BYTE - STEADY_BYTES_PER_IFC_BYTE) * bytes - current.wasm);
  const peak = current.total + STEADY_BYTES_PER_IFC_BYTE * bytes + wasmNeeded;
  const ratio = current.budget ? peak / current.budget : 0;
  return { fileBytes: bytes, peak, ratio, level: levelFor(ratio) };
}

export function levelFor(ratio) {
  if (ratio >= DANGER_AT) return LEVEL.DANGER;
  if (ratio >= WARN_AT) return LEVEL.WARN;
  return LEVEL.OK;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 MB';
  if (n >= GiB) return (n / GiB).toFixed(n >= 10 * GiB ? 0 : 1) + ' GB';
  return Math.round(n / MiB) + ' MB';
}
