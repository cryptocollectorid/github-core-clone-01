// Git smart-HTTP server: info/refs (protocol v0 + v2), ls-refs, fetch
// (v2 + v0), receive-pack (push). Works on the per-repo object store from
// store.ts. Deterministic: ref lists are sorted, packs are built from
// oid-sorted object sets.

import {
  buildCommit,
  decodeAllPktLines,
  decodePktLinesUntilFlush,
  DELIM,
  encodePktLine,
  encodeSideband,
  FLUSH,
  isAncestor,
  makeObject,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  resolveToCommit,
  writePack,
  type GitObject,
  type ObjType,
} from './gitobj.ts';
import { ApiError, branchRefName, type Repo, type Store } from './store.ts';
import { GIT_AGENT, ZERO_OID } from './util.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function textResponse(status: number, message: string): GitResponse {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify({ message }) + '\n', 'utf8'),
  };
}

const UPLOAD_CAPS = (defaultBranch: string): string =>
  `side-band-64k side-band thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/${defaultBranch} agent=${GIT_AGENT}`;
const RECEIVE_CAPS = (defaultBranch: string): string =>
  `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/${defaultBranch} agent=${GIT_AGENT}`;

/** Parse "/<owner>/<repo>.git/<action>" into its parts. */
function parseGitPath(path: string): { owner: string; repo: string; action: string } | null {
  const m = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m) return null;
  return { owner: m[1], repo: m[2], action: m[3] };
}

function allRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function defaultTip(repo: Repo): string | null {
  return repo.refs.get(branchRefName(repo, repo.defaultBranch)) ?? null;
}

function peelToCommit(repo: Repo, oid: string): string | null {
  return resolveToCommit(repo.objects, oid);
}

// ---------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------

function advertisementV2(): Buffer {
  return ADVERTISEMENT_V2;
}

/** The v2 capability advertisement never changes (no repository state in
 *  it), so it is built once and reused. */
const ADVERTISEMENT_V2: Buffer = Buffer.concat([
  encodePktLine('version 2\n'),
  encodePktLine(`agent=${GIT_AGENT}\n`),
  encodePktLine('ls-refs=unborn\n'),
  encodePktLine('fetch=shallow filter\n'),
  encodePktLine('object-format=sha1\n'),
  FLUSH,
]);

function advertisementV0(repo: Repo, service: string): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS(repo.defaultBranch) : RECEIVE_CAPS(repo.defaultBranch);
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), FLUSH];
  const refs = allRefs(repo);
  const tip = defaultTip(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headOid = tip ?? refs[0].oid;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const r of refs) {
      lines.push(`${r.oid} ${r.name}\n`);
      const obj = repo.objects.get(r.oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(repo, r.oid);
        if (peeled) lines.push(`${peeled} ${r.name}^{}\n`);
      }
    }
  }
  for (const l of lines) parts.push(encodePktLine(l));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleInfoRefs(repo: Repo, service: string, gitProtocol: string): GitResponse {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return textResponse(400, 'Invalid service.');
  }
  const ct =
    service === 'git-upload-pack'
      ? 'application/x-git-upload-pack-advertisement'
      : 'application/x-git-receive-pack-advertisement';
  if (gitProtocol === 'version=2' && service === 'git-upload-pack') {
    return { status: 200, contentType: ct, body: advertisementV2() };
  }
  return { status: 200, contentType: ct, body: advertisementV0(repo, service) };
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: Buffer[] = [];
  const tip = defaultTip(repo);
  const headMatches = args.prefixes.length === 0 || args.prefixes.some((p) => 'HEAD'.startsWith(p));
  if (tip) {
    if (headMatches) {
      const sym = args.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
      lines.push(encodePktLine(`${tip} HEAD${sym}\n`));
    }
  } else if (args.unborn && headMatches) {
    lines.push(encodePktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
  }
  for (const r of allRefs(repo)) {
    if (args.prefixes.length > 0 && !args.prefixes.some((p) => r.name.startsWith(p))) continue;
    let line = `${r.oid} ${r.name}`;
    const obj = repo.objects.get(r.oid);
    if (args.peel && obj && obj.type === 'tag') {
      const peeled = peelToCommit(repo, r.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    lines.push(encodePktLine(`${line}\n`));
  }
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------------------
// Object selection for fetch
// ---------------------------------------------------------------------------

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function treeClosure(store: Map<string, GitObject>, treeOid: string | null): Set<string> {
  const out = new Set<string>();
  if (!treeOid) return out;
  const walk = (oid: string): void => {
    if (out.has(oid)) return;
    const obj = store.get(oid);
    if (!obj) return;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) walk(e.oid);
    }
  };
  walk(treeOid);
  return out;
}

interface Selection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

// ---------------------------------------------------------------------------
// Fetch response cache
// ---------------------------------------------------------------------------

const FETCH_CACHE_MAX_ENTRIES = 64;
const FETCH_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const FETCH_CACHE_MAX_ENTRY_BYTES = 256 * 1024;

function fetchCacheKey(protocol: string, req: FetchRequest): string {
  return `${protocol}|${req.wants.join(',')}|${req.haves.join(',')}|${req.shallow.join(',')}|${req.depth ?? ''}`;
}

/** A fetch result is cacheable only when every oid the request names
 *  already exists in the store: the walk then depends solely on
 *  content-addressed, immutable objects, so the reply is byte-identical
 *  forever. A request naming a missing oid is computed fresh every time
 *  (its result could change once that object arrives). */
function fetchCacheable(repo: Repo, req: FetchRequest): boolean {
  for (const oid of [...req.wants, ...req.haves, ...req.shallow]) {
    if (!repo.objects.has(oid)) return false;
  }
  return true;
}

function fetchCached(repo: Repo, protocol: string, req: FetchRequest): Buffer | null {
  return repo.fetchCache.get(fetchCacheKey(protocol, req)) ?? null;
}

function fetchCacheStore(repo: Repo, protocol: string, req: FetchRequest, body: Buffer): void {
  if (body.length > FETCH_CACHE_MAX_ENTRY_BYTES) return;
  if (!fetchCacheable(repo, req)) return;
  const key = fetchCacheKey(protocol, req);
  const prev = repo.fetchCache.get(key);
  if (prev) repo.fetchCacheBytes -= prev.length;
  if (
    repo.fetchCache.size >= FETCH_CACHE_MAX_ENTRIES ||
    repo.fetchCacheBytes + body.length > FETCH_CACHE_MAX_BYTES
  ) {
    repo.fetchCache.clear();
    repo.fetchCacheBytes = 0;
  }
  repo.fetchCache.set(key, body);
  repo.fetchCacheBytes += body.length;
}

function selectObjects(repo: Repo, req: FetchRequest): Selection {
  const store = repo.objects;
  const clientShallow = new Set(req.shallow);
  // Commits the client already holds: walk from haves, stopping at shallow
  // boundaries (a shallow commit's parents are not held).
  const heldCommits = new Set<string>();
  {
    const queue = [...req.haves];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (heldCommits.has(oid)) continue;
      const obj = store.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      heldCommits.add(oid);
      if (clientShallow.has(oid)) continue;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
  }
  const heldObjects = new Set<string>();
  // Objects the client already holds: each held commit plus its tree
  // closure (tree, subtrees, blobs). Crucially NOT the commit's parents:
  // a held commit's ancestors are not held (that is what a deepen asks
  // for), so following parent links here would swallow the commits the
  // fetch must deliver.
  for (const c of heldCommits) {
    heldObjects.add(c);
    const obj = store.get(c);
    if (obj && obj.type === 'commit') {
      for (const t of treeClosure(store, parseCommit(obj.data).tree)) heldObjects.add(t);
    } else if (obj && obj.type === 'tag') {
      const target = resolveToCommit(store, c);
      if (target) {
        heldObjects.add(target);
        const targetObj = store.get(target);
        if (targetObj && targetObj.type === 'commit') {
          for (const t of treeClosure(store, parseCommit(targetObj.data).tree)) heldObjects.add(t);
        }
      }
    }
  }
  // Walk from wants with generations. Held commits are never re-sent, but
  // their parents are still traversed (a deepen asks for them); the depth
  // limit and the shallow boundary stop the walk.
  const included = new Set<string>();
  const boundary = new Set<string>();
  const tagObjects = new Set<string>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of req.wants) {
    let cur = want;
    const guard = new Set<string>();
    while (cur && !guard.has(cur)) {
      guard.add(cur);
      const obj = store.get(cur);
      if (!obj) break;
      if (obj.type === 'tag') {
        tagObjects.add(cur);
        cur = parseTag(obj.data).object;
        continue;
      }
      if (obj.type === 'commit') {
        queue.push({ oid: cur, gen: 1 });
      }
      break;
    }
  }
  const visited = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const isHeld = heldCommits.has(oid);
    if (!isHeld) {
      included.add(oid);
      if (req.depth !== null && gen >= req.depth) {
        boundary.add(oid);
        continue;
      }
    } else if (req.depth !== null && gen >= req.depth) {
      continue;
    }
    if (clientShallow.has(oid) && req.depth === null) continue;
    const c = parseCommit(obj.data);
    for (const p of c.parents) queue.push({ oid: p, gen: gen + 1 });
  }
  // Assemble the object set: tags + included commits + their tree closures,
  // minus anything the client already holds.
  const toSend = new Set<string>();
  for (const t of tagObjects) toSend.add(t);
  for (const oid of included) {
    toSend.add(oid);
    const commit = store.get(oid);
    if (!commit || commit.type !== 'commit') continue;
    for (const t of treeClosure(store, parseCommit(commit.data).tree)) toSend.add(t);
  }
  for (const h of heldObjects) toSend.delete(h);
  const objects = new Map<string, GitObject>();
  for (const oid of [...toSend].sort()) {
    const obj = store.get(oid);
    if (obj) objects.set(oid, obj);
  }
  // Shallow: commits at the depth limit that were sent.
  const shallow = [...boundary].sort();
  // Unshallow: previously-shallow commits whose parents are all present now.
  const unshallow: string[] = [];
  for (const c of [...clientShallow].sort()) {
    if (boundary.has(c)) continue;
    if (!heldCommits.has(c) && !included.has(c)) continue;
    const obj = store.get(c);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => heldCommits.has(p) || included.has(p))) {
      unshallow.push(c);
    }
  }
  return { objects, shallow, unshallow };
}

function packEntries(objects: Map<string, GitObject>): Array<{ oid: string; type: ObjType; data: Buffer }> {
  const out: Array<{ oid: string; type: ObjType; data: Buffer }> = [];
  for (const [oid, obj] of objects) out.push({ oid, type: obj.type, data: obj.data });
  return out;
}

function fetchResponseV2(sel: Selection): Buffer {
  const parts: Buffer[] = [encodePktLine('acknowledgments\n'), encodePktLine('NAK\n'), DELIM];
  if (sel.shallow.length > 0 || sel.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const s of sel.shallow) parts.push(encodePktLine(`shallow ${s}\n`));
    for (const s of sel.unshallow) parts.push(encodePktLine(`unshallow ${s}\n`));
    parts.push(DELIM);
  }
  const pack = writePack(packEntries(sel.objects));
  parts.push(encodePktLine('packfile\n'));
  parts.push(encodeSideband(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponseV0(sel: Selection): Buffer {
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const s of sel.shallow) parts.push(encodePktLine(`shallow ${s}\n`));
  for (const s of sel.unshallow) parts.push(encodePktLine(`unshallow ${s}\n`));
  const pack = writePack(packEntries(sel.objects));
  parts.push(encodeSideband(1, pack));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack POST (v2 command stream / v0 want-have stream)
// ---------------------------------------------------------------------------

function parseV2Upload(body: Buffer): { command: string; args: string[] } {
  const packets = decodeAllPktLines(body);
  let command = '';
  const args: string[] = [];
  let section = 0; // 0 = command, 1 = args
  for (const p of packets) {
    if (p.kind === 'delim') {
      section = 1;
      continue;
    }
    if (p.kind === 'flush') break;
    const line = p.data.toString('utf8');
    if (section === 0) {
      if (line.startsWith('command=')) command = line.slice('command='.length).trim();
    } else {
      args.push(line.trim());
    }
  }
  return { command, args };
}

function parseV0Upload(body: Buffer): FetchRequest {
  const { packets, restOffset } = decodePktLinesUntilFlush(body);
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.data.toString('utf8').trim();
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      const oid = rest.split(' ')[0];
      req.wants.push(oid);
    } else if (line.startsWith('shallow ')) {
      req.shallow.push(line.slice(8).trim());
    } else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (!Number.isNaN(n)) req.depth = n;
    }
  }
  const rest = decodeAllPktLines(body.subarray(restOffset));
  for (const p of rest) {
    if (p.kind !== 'data') continue;
    const line = p.data.toString('utf8').trim();
    if (line.startsWith('have ')) req.haves.push(line.slice(5).trim());
    else if (line === 'done') break;
  }
  return req;
}

function handleUploadPack(repo: Repo, body: Buffer, gitProtocol: string): GitResponse {
  const ct = 'application/x-git-upload-pack-result';
  if (gitProtocol === 'version=2') {
    let parsed: { command: string; args: string[] };
    try {
      parsed = parseV2Upload(body);
    } catch (e) {
      return textResponse(400, `Malformed request: ${(e as Error).message}`);
    }
    if (parsed.command === 'ls-refs') {
      const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const a of parsed.args) {
        if (a === 'peel') args.peel = true;
        else if (a === 'symrefs') args.symrefs = true;
        else if (a === 'unborn') args.unborn = true;
        else if (a.startsWith('ref-prefix ')) args.prefixes.push(a.slice('ref-prefix '.length));
      }
      return { status: 200, contentType: ct, body: handleLsRefs(repo, args) };
    }
    if (parsed.command === 'fetch') {
      const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
      for (const a of parsed.args) {
        if (a.startsWith('want ')) req.wants.push(a.slice(5).trim());
        else if (a.startsWith('have ')) req.haves.push(a.slice(5).trim());
        else if (a.startsWith('shallow ')) req.shallow.push(a.slice(8).trim());
        else if (a.startsWith('deepen ')) {
          const n = parseInt(a.slice(7).trim(), 10);
          if (!Number.isNaN(n)) req.depth = n;
        }
      }
      const cached = fetchCached(repo, 'v2', req);
      if (cached) return { status: 200, contentType: ct, body: cached };
      const sel = selectObjects(repo, req);
      const body = fetchResponseV2(sel);
      fetchCacheStore(repo, 'v2', req, body);
      return { status: 200, contentType: ct, body };
    }
    return textResponse(400, `Unknown command: ${parsed.command}`);
  }
  // Protocol v0.
  let req: FetchRequest;
  try {
    req = parseV0Upload(body);
  } catch (e) {
    return textResponse(400, `Malformed request: ${(e as Error).message}`);
  }
  const cached = fetchCached(repo, 'v0', req);
  if (cached) return { status: 200, contentType: ct, body: cached };
  const sel = selectObjects(repo, req);
  const resBody = fetchResponseV0(sel);
  fetchCacheStore(repo, 'v0', req, resBody);
  return { status: 200, contentType: ct, body: resBody };
}

// ---------------------------------------------------------------------------
// receive-pack POST (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer): GitResponse {
  const ct = 'application/x-git-receive-pack-result';
  const reportLines: string[] = [];
  let commands: PushCommand[] = [];
  let packBytes = Buffer.alloc(0);
  try {
    const { packets, restOffset } = decodePktLinesUntilFlush(body);
    // readPack only reads the pack; no copy of the bytes is needed.
    packBytes = body.subarray(restOffset);
    for (const p of packets) {
      if (p.kind !== 'data') continue;
      let line = p.data.toString('utf8');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(line.trim());
      if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
    }
  } catch (e) {
    return sendPushReport(ct, [`unpack error malformed request: ${(e as Error).message}`], commands);
  }
  // Unpack first: objects stay stored even when a ref update is refused.
  let unpackOk = true;
  let unpackError = '';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, repo.objects);
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch (e) {
      unpackOk = false;
      unpackError = (e as Error).message;
    }
  }
  if (!unpackOk) {
    const lines = [`unpack error ${unpackError}`];
    for (const c of commands) lines.push(`ng ${c.ref} unpack error`);
    return sendPushReport(ct, lines, commands);
  }
  reportLines.push('unpack ok');
  for (const cmd of commands) {
    const result = applyPushCommand(repo, cmd);
    reportLines.push(result);
  }
  return sendPushReport(ct, reportLines, commands);
}

function sendPushReport(ct: string, lines: string[], commands: PushCommand[]): GitResponse {
  const inner = Buffer.concat(lines.map((l) => encodePktLine(`${l}\n`)));
  const body = Buffer.concat([encodeSideband(1, inner), FLUSH]);
  return { status: 200, contentType: ct, body };
}

function applyPushCommand(repo: Repo, cmd: PushCommand): string {
  const { oldOid, newOid, ref } = cmd;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (!current) return `ng ${ref} remote ref does not exist`;
    if (current !== oldOid) return `ng ${ref} stale info`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  // The new object must exist after unpacking.
  const newObj = repo.objects.get(newOid);
  if (!newObj) return `ng ${ref} unable to read ${newOid}`;
  if (oldOid === ZERO_OID) {
    // Create.
    if (current) return `ng ${ref} already exists`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  // Update.
  if (!current) return `ng ${ref} cannot lock ref`;
  if (current !== oldOid) return `ng ${ref} stale info`;
  const newCommit = resolveToCommit(repo.objects, newOid);
  if (!newCommit) return `ng ${ref} unable to resolve ${newOid}`;
  if (!isAncestor(repo.objects, oldOid, newCommit)) {
    return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface GitRequestInput {
  method: string;
  path: string;
  query: URLSearchParams;
  gitProtocol: string;
  body: Buffer;
}

/** Handle a git smart-HTTP request. Returns null when the path is not a
 *  git route (the caller then falls through to REST / other handlers). */
export function handleGit(
  store: Store,
  req: GitRequestInput,
): GitResponse | null {
  const parsed = parseGitPath(req.path);
  if (!parsed) return null;
  if (parsed.owner !== store.viewerLogin) {
    return textResponse(404, 'Repository not found.');
  }
  const repo = store.getRepo(parsed.owner, parsed.repo);
  if (!repo) return textResponse(404, 'Repository not found.');
  if (req.method === 'GET' && parsed.action === 'info/refs') {
    const service = req.query.get('service') ?? '';
    return handleInfoRefs(repo, service, req.gitProtocol);
  }
  if (req.method === 'POST' && parsed.action === 'git-upload-pack') {
    return handleUploadPack(repo, req.body, req.gitProtocol);
  }
  if (req.method === 'POST' && parsed.action === 'git-receive-pack') {
    return handleReceivePack(store, repo, req.body);
  }
  return textResponse(405, 'Method not allowed.');
}
