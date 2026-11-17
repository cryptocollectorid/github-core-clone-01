// Git object model: pkt-lines, pack read/write, object parse/build,
// reachability and tree operations. Pure functions over a per-repo object
// store (Map<oid, GitObject>). No I/O, no clocks, no randomness.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { sha1Hex, FIXED_GIT_TS, ZERO_OID } from './util.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export const TYPE_NUM: Record<ObjType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};
export const NUM_TYPE: Record<number, ObjType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

export const COMMIT_AUTHOR = 'Conformance <conformance@make.fun>';

/** SHA-1 id of a git object: sha1("<type> <size>\\0" + data). */
export function objectId(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export function makeObject(type: ObjType, data: Buffer): { oid: string; obj: GitObject } {
  return { oid: objectId(type, data), obj: { type, data } };
}

// ---------------------------------------------------------------------------
// Tree / commit / tag parse + build
// ---------------------------------------------------------------------------

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('corrupt tree: no mode terminator');
    const mode = data.subarray(off, sp).toString('utf8');
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) throw new Error('corrupt tree: no name terminator');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.name + (e.mode === '40000' ? '/' : '');
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  const out: ParsedCommit = { tree: '', parents: [], message, author: '', committer: '' };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export function buildCommit(
  tree: string,
  parents: string[],
  message: string,
  ts: number = FIXED_GIT_TS,
  identity: string = COMMIT_AUTHOR,
): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${identity} ${ts} +0000`);
  lines.push(`committer ${identity} ${ts} +0000`);
  lines.push('');
  lines.push(message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank >= 0 ? text.slice(0, blank) : text;
  const message = blank >= 0 ? text.slice(blank + 2) : '';
  const out: ParsedTag = { object: '', type: '', tag: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
  }
  return out;
}

export function buildTag(
  object: string,
  type: string,
  tag: string,
  message: string,
  ts: number = FIXED_GIT_TS,
  identity: string = COMMIT_AUTHOR,
): Buffer {
  const lines = [
    `object ${object}`,
    `type ${type}`,
    `tag ${tag}`,
    `tagger ${identity} ${ts} +0000`,
    '',
    message,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function encodePktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export interface PktPacket {
  kind: 'data' | 'flush' | 'delim';
  data: Buffer;
}

/** Decode pkt-lines from the start of buf until the first flush (exclusive
 *  of the flush) or the end of the buffer. Returns the packets and the
 *  offset just past the terminating flush (or buf.length). */
export function decodePktLinesUntilFlush(buf: Buffer): { packets: PktPacket[]; restOffset: number } {
  const packets: PktPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) throw new Error('invalid pkt-line length');
    if (len === 0) {
      packets.push({ kind: 'flush', data: Buffer.alloc(0) });
      return { packets, restOffset: off + 4 };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', data: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return { packets, restOffset: off };
}

/** Decode every pkt-line in buf (used for sideband + v2 command streams). */
export function decodeAllPktLines(buf: Buffer): PktPacket[] {
  const out: PktPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) throw new Error('invalid pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim', data: Buffer.alloc(0) });
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) throw new Error('pkt-line length out of range');
    out.push({ kind: 'data', data: Buffer.from(buf.subarray(off + 4, off + len)) });
    off += len;
  }
  return out;
}

/** Split a byte payload into sideband pkt-lines (band byte + <=65515 data). */
export function encodeSideband(band: number, payload: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const maxChunk = 65515;
  for (let off = 0; off < payload.length; off += maxChunk) {
    const piece = payload.subarray(off, Math.min(payload.length, off + maxChunk));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([band]), piece])));
  }
  if (payload.length === 0) {
    chunks.push(encodePktLine(Buffer.from([band])));
  }
  return Buffer.concat(chunks);
}

/** Demultiplex sideband pkt-lines into per-band payloads. */
export function decodeSideband(buf: Buffer): Map<number, Buffer> {
  const bands = new Map<number, Buffer[]>();
  for (const p of decodeAllPktLines(buf)) {
    if (p.kind !== 'data' || p.data.length === 0) continue;
    const band = p.data[0];
    const list = bands.get(band) ?? [];
    list.push(Buffer.from(p.data.subarray(1)));
    bands.set(band, list);
  }
  const out = new Map<number, Buffer>();
  for (const [band, list] of bands) out.set(band, Buffer.concat(list));
  return out;
}

// ---------------------------------------------------------------------------
// Pack write / read
// ---------------------------------------------------------------------------

/** Write a pack (version 2, plain objects only, no deltas). */
export function writePack(entries: Array<{ oid: string; type: ObjType; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  chunks.push(header);
  for (const e of entries) {
    const typeNum = TYPE_NUM[e.type];
    const deflated = deflateSync(e.data);
    let size = e.data.length;
    const first = (size & 0x0f) | (typeNum << 4);
    size >>= 4;
    const headBytes: number[] = [];
    headBytes.push(size > 0 ? first | 0x80 : first);
    while (size > 0) {
      const b = size & 0x7f;
      size >>= 7;
      headBytes.push(size > 0 ? b | 0x80 : b);
    }
    chunks.push(Buffer.from(headBytes), deflated);
  }
  const body = Buffer.concat(chunks);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Adler-32 checksum (the trailer of every zlib stream). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Find the length of the deflate stream starting at `off` in buf, knowing
 *  its inflated size. inflateSync ignores trailing bytes, so one call
 *  inflates the first stream; the stream's end is the position of its
 *  Adler-32 trailer (verified by re-inflating the exact slice). This costs
 *  two inflateSync calls per object instead of a binary search's ~eleven. */
function findDeflateEnd(buf: Buffer, off: number, inflatedSize: number): number {
  const data = inflateSync(buf.subarray(off));
  if (data.length !== inflatedSize) throw new Error('pack object size mismatch');
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(data), 0);
  // The stream is at least 2 (zlib header) + 1 (deflate) + 4 (adler) bytes.
  let pos = off + 2;
  for (;;) {
    const idx = buf.indexOf(needle, pos);
    if (idx < 0) throw new Error('deflate stream end not found');
    const len = idx - off + 4;
    if (len >= 7) {
      try {
        const check = inflateSync(buf.subarray(off, off + len));
        if (check.length === inflatedSize) return len;
      } catch {
        // Not the true end (a coincidental match inside the deflate data).
      }
    }
    pos = idx + 1;
  }
}

/** Apply a git delta to a base object, returning the result buffer. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let n = 0;
    let shift = 0;
    let b: number;
    do {
      b = delta[off++];
      n |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return n;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize || total !== resultSize) {
    throw new Error('delta result size mismatch');
  }
  return result;
}

export interface PackEntry {
  oid: string;
  type: ObjType;
  data: Buffer;
}

/** Parse a pack buffer into objects. Resolves OFS/REF deltas against
 *  objects in the same pack and the optional `known` store. */
export function readPack(buf: Buffer, known?: Map<string, GitObject>): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  let off = 12;
  const byOffset = new Map<number, PackEntry>();
  const byOid = new Map<string, PackEntry>();
  const pending: Array<{ entryOff: number; baseOid: string | null; baseOff: number; typeNum: number; data: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    const entryOff = off;
    let b = buf[off++];
    const typeNum = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOff = 0;
    if (typeNum === 6) {
      // OFS_DELTA: negative offset varint relative to this entry's start.
      b = buf[off++];
      let n = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++];
        n = ((n + 1) << 7) | (b & 0x7f);
      }
      baseOff = entryOff - n;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!(typeNum in NUM_TYPE)) {
      throw new Error(`unknown pack object type ${typeNum}`);
    }
    const streamLen = findDeflateEnd(buf, off, size);
    const data = inflateSync(buf.subarray(off, off + streamLen));
    if (data.length !== size) throw new Error('pack object size mismatch');
    off += streamLen;
    if (typeNum === 6 || typeNum === 7) {
      pending.push({ entryOff, baseOid, baseOff, typeNum, data });
    } else {
      const type = NUM_TYPE[typeNum];
      const oid = objectId(type, data);
      const entry: PackEntry = { oid, type, data };
      byOffset.set(entryOff, entry);
      byOid.set(oid, entry);
    }
  }
  // Resolve deltas (bases may appear later in the pack for REF_DELTA).
  for (let round = 0; round < pending.length + 2 && pending.length > 0; round++) {
    const still: typeof pending = [];
    for (const p of pending) {
      let base: GitObject | PackEntry | undefined;
      if (p.baseOid) {
        base = byOid.get(p.baseOid) ?? known?.get(p.baseOid);
      } else {
        base = byOffset.get(p.baseOff);
      }
      if (!base) {
        still.push(p);
        continue;
      }
      const data = applyDelta(base.data, p.data);
      const type = base.type;
      const oid = objectId(type, data);
      const entry: PackEntry = { oid, type, data };
      byOffset.set(p.entryOff, entry);
      byOid.set(oid, entry);
    }
    if (still.length === pending.length) break;
    pending.length = 0;
    pending.push(...still);
  }
  if (pending.length > 0) throw new Error('unresolved delta base in pack');
  const out = new Map<string, GitObject>();
  for (const [oid, e] of byOid) out.set(oid, { type: e.type, data: e.data });
  return out;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

export type ObjectStore = Map<string, GitObject>;

export function getObject(store: ObjectStore, oid: string): GitObject | undefined {
  return store.get(oid);
}

/** All objects reachable from the given roots (commits, trees, blobs,
 *  tags). Follows commit parents + trees, tree entries, tag targets. */
export function collectReachable(store: ObjectStore, roots: string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** All commit oids reachable from a tip (following every parent). */
export function commitAncestors(store: ObjectStore, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return seen;
}

/** First-parent chain from a tip, newest first. */
export function firstParentChain(store: ObjectStore, tip: string): string[] {
  const chain: string[] = [];
  let cur: string | null = tip;
  const guard = new Set<string>();
  while (cur && cur !== ZERO_OID && !guard.has(cur)) {
    guard.add(cur);
    const obj = store.get(cur);
    if (!obj || obj.type !== 'commit') break;
    chain.push(cur);
    const c = parseCommit(obj.data);
    cur = c.parents.length > 0 ? c.parents[0] : null;
  }
  return chain;
}

/** Merge-base of two commits: the newest commit reachable from both. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const bAnc = commitAncestors(store, b);
  const queue: string[] = [a];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (bAnc.has(oid)) return oid;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

/** Is `ancestor` reachable from `descendant` (following parents)? Walks
 *  depth-first and stops the moment the ancestor is found, so a
 *  fast-forward check on a long linear chain costs one step, not a full
 *  history scan. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return false;
}

/** Resolve a ref-ish to a commit oid: tag objects peel to their target. */
export function resolveToCommit(store: ObjectStore, oid: string): string | null {
  let cur = oid;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const obj = store.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      cur = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tree path operations (store objects as needed; return new root tree oid)
// ---------------------------------------------------------------------------

function treeEntriesOf(store: ObjectStore, treeOid: string | null): TreeEntry[] {
  if (!treeOid) return [];
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data);
}

function storeTree(store: ObjectStore, entries: TreeEntry[]): string {
  const data = buildTree(entries);
  const { oid, obj } = makeObject('tree', data);
  store.set(oid, obj);
  return oid;
}

/** Set (or replace) a file at `segments` in the tree rooted at
 *  `rootTreeOid`, creating intermediate trees. Returns the new root oid. */
export function treeSet(
  store: ObjectStore,
  rootTreeOid: string | null,
  segments: string[],
  blobOid: string,
): string {
  if (segments.length === 0) throw new Error('empty path');
  const entries = treeEntriesOf(store, rootTreeOid);
  const [head, ...rest] = segments;
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    const entry: TreeEntry = { mode: '100644', name: head, oid: blobOid };
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    return storeTree(store, entries);
  }
  let subOid: string | null = null;
  if (idx >= 0 && entries[idx].mode === '40000') subOid = entries[idx].oid;
  const newSub = treeSet(store, subOid, rest, blobOid);
  const entry: TreeEntry = { mode: '40000', name: head, oid: newSub };
  if (idx >= 0) entries[idx] = entry;
  else entries.push(entry);
  return storeTree(store, entries);
}

/** Delete the file at `segments`. Returns the new root tree oid, or null
 *  when the tree becomes empty. */
export function treeDelete(
  store: ObjectStore,
  rootTreeOid: string | null,
  segments: string[],
): string | null {
  if (!rootTreeOid || segments.length === 0) return rootTreeOid;
  const entries = treeEntriesOf(store, rootTreeOid);
  const [head, ...rest] = segments;
  const idx = entries.findIndex((e) => e.name === head);
  if (idx < 0) return rootTreeOid;
  if (rest.length === 0) {
    entries.splice(idx, 1);
  } else {
    if (entries[idx].mode !== '40000') return rootTreeOid;
    const newSub = treeDelete(store, entries[idx].oid, rest);
    if (newSub === null) entries.splice(idx, 1);
    else entries[idx] = { mode: '40000', name: head, oid: newSub };
  }
  if (entries.length === 0) return null;
  return storeTree(store, entries);
}

/** Look up a path in a tree. Returns the entry or null. */
export function treeGet(
  store: ObjectStore,
  rootTreeOid: string | null,
  segments: string[],
): TreeEntry | null {
  if (!rootTreeOid) return null;
  let cur: string | null = rootTreeOid;
  for (let i = 0; i < segments.length; i++) {
    if (!cur) return null;
    const entries = treeEntriesOf(store, cur);
    const found = entries.find((e) => e.name === segments[i]);
    if (!found) return null;
    if (i === segments.length - 1) return found;
    if (found.mode !== '40000') return null;
    cur = found.oid;
  }
  return null;
}

/** Flatten a tree to path -> { mode, oid } for files only (recursive). */
export function treeFlatten(
  store: ObjectStore,
  rootTreeOid: string | null,
  prefix = '',
): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  if (!rootTreeOid) return out;
  const walk = (treeOid: string, base: string): void => {
    for (const e of treeEntriesOf(store, treeOid)) {
      const path = base ? `${base}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { mode: e.mode, oid: e.oid });
    }
  };
  walk(rootTreeOid, prefix);
  return out;
}

/** Paths whose blob differs between two trees (added / deleted / modified). */
export function diffTrees(
  store: ObjectStore,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): Array<{ path: string; baseOid: string | null; headOid: string | null }> {
  const base = treeFlatten(store, baseTreeOid);
  const head = treeFlatten(store, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: Array<{ path: string; baseOid: string | null; headOid: string | null }> = [];
  for (const p of [...paths].sort()) {
    const b = base.get(p);
    const h = head.get(p);
    if (b?.oid !== h?.oid) {
      out.push({ path: p, baseOid: b?.oid ?? null, headOid: h?.oid ?? null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line diff (LCS) for PR file stats
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Count added / deleted lines between two texts (LCS-based). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0 && b.length === 0) return { additions: 0, deletions: 0 };
  // LCS via DP with two rows.
  const n = a.length;
  const m = b.length;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const lcs = prev[m];
  return { additions: m - lcs, deletions: n - lcs };
}
