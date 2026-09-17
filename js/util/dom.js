/**
 * Small DOM helpers shared by the shell and by check modules.
 *
 * Check modules render their own results, so they need the same escaping the
 * shell uses. Sharing one implementation means there is one place where an
 * escaping bug could live, rather than one per module.
 */

const escaper = document.createElement('div');

/** Escapes a value for interpolation into an HTML string. */
export function esc(s) {
  escaper.textContent = s === null || s === undefined ? '' : String(s);
  return escaper.innerHTML;
}

/** 0xRRGGBB -> "#rrggbb", for inline styles. */
export function hex(n) {
  return '#' + Number(n).toString(16).padStart(6, '0');
}
