/**
 * Identifiers. IFC compresses a 128-bit UUID into 22 characters of its own
 * base-64 alphabet; BCF uses plain UUID strings. Both come from the browser's
 * cryptographic random source.
 */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** A random UUID v4 in the canonical lower-case form. */
export function uuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * A fresh IFC GlobalId. The 128 bits are packed 2 + 20 × 6, high bits first,
 * exactly as IfcGloballyUniqueId specifies.
 */
export function ifcGuid() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  return packGuid(b);
}

function packGuid(bytes) {
  // Treat the 16 bytes as a big-endian number and emit 6-bit groups, the first
  // group holding only the top 2 bits.
  let bits = 0n;
  for (const x of bytes) bits = (bits << 8n) | BigInt(x);
  let out = '';
  for (let i = 0; i < 22; i++) {
    const shift = BigInt((21 - i) * 6);
    out += ALPHABET[Number((bits >> shift) & 63n)];
  }
  return out;
}
