// Shared helpers for the Mitecho forge.
// Deterministic by design: no wall-clock time, no randomness anywhere in
// this file. Every value derived from logical counters or fixed constants.

import { createHash } from 'node:crypto';

/** Fixed timestamp used for every server-created git commit (seconds). */
export const FIXED_GIT_TS = 1700000000;
/** Base epoch (seconds) for REST created_at / updated_at; derived values
 *  are base + logical sequence, so two runs with the same request order
 *  produce identical timestamps. */
export const ISO_EPOCH = 1735689600; // 2025-01-01T00:00:00Z
export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_ID = 1000;
export const FORGE_NAME = 'mitecho-forge';
export const FORGE_VERSION = '1.0.0';
export const GIT_AGENT = 'forge/1.0';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** ISO 8601 string for a logical sequence number (deterministic). */
export function isoFromSeq(seq: number): string {
  return new Date((ISO_EPOCH + seq) * 1000).toISOString();
}

/** Opaque, stable GraphQL global id: base64 of a typed key. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id back into { kind, key } or null when malformed. */
export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const i = raw.indexOf(':');
    if (i <= 0) return null;
    return { kind: raw.slice(0, i), key: raw.slice(i + 1) };
  } catch {
    return null;
  }
}

export function isValidOid(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s);
}

export function b64encode(buf: Buffer): string {
  return buf.toString('base64');
}

export function b64decode(s: string): Buffer {
  return Buffer.from(s, 'base64');
}

/** Escape a string for inclusion in a JSON error message (no newlines). */
export function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

/** Split a path like "a/b/c.txt" into segments, dropping empty parts. */
export function pathSegments(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}
