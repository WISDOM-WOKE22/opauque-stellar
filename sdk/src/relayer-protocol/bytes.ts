/**
 * Internal byte helpers for the relayer protocol. Kept separate from
 * `crypto/bytes` because the wire format here uses 0x-prefixed hex and exact
 * i128/length encodings that must byte-match the relayer node and the
 * relayer-registry contract.
 */

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2 !== 0) {
    throw new Error("Invalid hex string.");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

export function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(value);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  const buffer = (globalThis as unknown as { Buffer?: { from(v: string, enc: "base64"): Uint8Array } }).Buffer;
  if (!buffer) throw new Error("No base64 decoder available.");
  return Uint8Array.from(buffer.from(value, "base64"));
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  const buffer = (globalThis as unknown as { Buffer?: { from(v: Uint8Array): { toString(enc: "base64"): string } } }).Buffer;
  if (!buffer) throw new Error("No base64 encoder available.");
  return buffer.from(bytes).toString("base64");
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function assertLength(bytes: Uint8Array, len: number, label: string): Uint8Array {
  if (bytes.length !== len) {
    throw new Error(`${label} must be ${len} bytes, got ${bytes.length}.`);
  }
  return bytes;
}

export function i128ToBytes(value: bigint): Uint8Array {
  const min = -(1n << 127n);
  const max = (1n << 127n) - 1n;
  if (value < min || value > max) throw new Error("i128 out of range.");
  let unsigned = value;
  if (value < 0) unsigned = (1n << 128n) + value;
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i -= 1) {
    out[i] = Number(unsigned & 0xffn);
    unsigned >>= 8n;
  }
  return out;
}

export function u32ToBytes(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error("u32 out of range.");
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}
