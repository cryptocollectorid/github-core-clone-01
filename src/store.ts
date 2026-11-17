// In-memory store and the shared business logic for repositories, issues,
// pull requests, labels, comments and contents. REST, GraphQL and MCP all
// call into this module, so the three surfaces always see the same state.
// Deterministic: ids and timestamps come from a single logical counter.

import {
  buildCommit,
  buildTree,
  diffTrees,
  lineDiff,
  makeObject,
  mergeBase,
  parseCommit,
  parseTree,
  resolveToCommit,
  treeDelete,
  treeGet,
  treeSet,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';
import { b64decode, b64encode, isoFromSeq, pathSegments } from './util.ts';

/** Error carrying an HTTP status, raised by store logic and rendered as a
 *  JSON {"message": ...} body by the REST layer (and translated by the
 *  GraphQL / MCP layers). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface IssueComment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  updatedSeq: number;
  comments: IssueComment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  nextIssueNumber: number;
  pulls: Map<number, Pull>;
  nextPullNumber: number;
  labels: Map<string, Label>;
}

export class Store {
  repos = new Map<string, Repo>();
  viewerLogin: string;
  private seq = 0;
  private nextRepoId = 0;

  constructor(viewerLogin: string) {
    this.viewerLogin = viewerLogin;
  }

  /** Next logical sequence number (ids, ordering, timestamps). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(name: string, opts: { description?: string; isPrivate?: boolean; defaultBranch?: string }): Repo {
    const key = this.repoKey(this.viewerLogin, name);
    if (this.repos.has(key)) {
      throw new ApiError(422, `Repository '${name}' already exists.`);
    }
    this.nextRepoId += 1;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewerLogin,
      description: opts.description ?? '',
      isPrivate: opts.isPrivate ?? false,
      defaultBranch: opts.defaultBranch && opts.defaultBranch.length > 0 ? opts.defaultBranch : 'main',
      createdSeq: this.nextSeq(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      nextIssueNumber: 1,
      pulls: new Map(),
      nextPullNumber: 1,
      labels: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export function branchRefName(repo: Repo, branch: string): string {
  return `refs/heads/${branch}`;
}

export function defaultTip(repo: Repo): string | null {
  return repo.refs.get(branchRefName(repo, repo.defaultBranch)) ?? null;
}

/** Resolve a branch name or commit oid to a commit oid, or null. */
export function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (!ref) return defaultTip(repo);
  const byBranch = repo.refs.get(branchRefName(repo, ref));
  if (byBranch) return byBranch;
  if (repo.objects.has(ref)) return resolveToCommit(repo.objects, ref);
  return null;
}

export function isUnborn(repo: Repo): boolean {
  return repo.refs.size === 0;
}

// ---------------------------------------------------------------------------
// Issues / comments / labels
// ---------------------------------------------------------------------------

export function createIssue(
  store: Store,
  repo: Repo,
  input: { title: string; body?: string; labels?: string[] },
): Issue {
  const labelNames = input.labels ?? [];
  for (const name of labelNames) {
    if (!repo.labels.has(name)) {
      throw new ApiError(422, `Label does not exist: ${name}`);
    }
  }
  const seq = store.nextSeq();
  const issue: Issue = {
    id: seq,
    number: repo.nextIssueNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labelNames],
    createdSeq: seq,
    updatedSeq: seq,
    comments: [],
  };
  repo.nextIssueNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function listIssues(
  repo: Repo,
  opts: { state?: string; direction?: string },
): Issue[] {
  const state = opts.state ?? 'open';
  let list = [...repo.issues.values()];
  if (state !== 'all') list = list.filter((i) => i.state === state);
  const dir = opts.direction ?? 'desc';
  list.sort((a, b) => (dir === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  return list;
}

export function getIssue(repo: Repo, number: number): Issue {
  const issue = repo.issues.get(number);
  if (!issue) throw new ApiError(404, `Issue #${number} not found.`);
  return issue;
}

export function createComment(store: Store, repo: Repo, issueNumber: number, body: string): IssueComment {
  const issue = getIssue(repo, issueNumber);
  const seq = store.nextSeq();
  const comment: IssueComment = { id: seq, body, createdSeq: seq };
  issue.comments.push(comment);
  return comment;
}

export function createLabel(repo: Repo, name: string, color: string): Label {
  if (repo.labels.has(name)) {
    throw new ApiError(422, `Label '${name}' already exists.`);
  }
  const label: Label = { name, color };
  repo.labels.set(name, label);
  return label;
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export function createPull(
  store: Store,
  repo: Repo,
  input: { head: string; base: string; title: string; body?: string },
): Pull {
  const headSha = repo.refs.get(branchRefName(repo, input.head));
  const baseSha = repo.refs.get(branchRefName(repo, input.base));
  if (!headSha) throw new ApiError(422, `Head branch '${input.head}' not found.`);
  if (!baseSha) throw new ApiError(422, `Base branch '${input.base}' not found.`);
  const seq = store.nextSeq();
  const pr: Pull = {
    id: seq,
    number: repo.nextPullNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head: input.head,
    base: input.base,
    headSha,
    baseSha,
    createdSeq: seq,
  };
  repo.nextPullNumber += 1;
  repo.pulls.set(pr.number, pr);
  return pr;
}

export function getPull(repo: Repo, number: number): Pull {
  const pr = repo.pulls.get(number);
  if (!pr) throw new ApiError(404, `Pull request #${number} not found.`);
  return pr;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The current tip of a pull request's branch, falling back to the sha
 *  recorded when the pull request was created (the branch may be gone). */
function prTip(repo: Repo, branch: string, fallback: string): string {
  return repo.refs.get(branchRefName(repo, branch)) ?? fallback;
}

/** Two-way diff between the base tip tree and the head tip tree. */
export function pullFiles(store: Store, repo: Repo, pr: Pull): PullFile[] {
  const baseSha = prTip(repo, pr.base, pr.baseSha);
  const headSha = prTip(repo, pr.head, pr.headSha);
  const baseCommit = repo.objects.get(baseSha);
  const headCommit = repo.objects.get(headSha);
  const baseTree = baseCommit && baseCommit.type === 'commit' ? parseCommit(baseCommit.data).tree : null;
  const headTree = headCommit && headCommit.type === 'commit' ? parseCommit(headCommit.data).tree : null;
  const diffs = diffTrees(repo.objects, baseTree, headTree);
  const out: PullFile[] = [];
  for (const d of diffs) {
    const oldText = d.baseOid ? blobText(repo, d.baseOid) : '';
    const newText = d.headOid ? blobText(repo, d.headOid) : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    const status: PullFile['status'] =
      d.baseOid === null ? 'added' : d.headOid === null ? 'removed' : 'modified';
    out.push({
      filename: d.path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

function blobText(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'blob') return '';
  return obj.data.toString('utf8');
}

/** File-level 3-way conflict check against the merge-base. */
export function pullMergeable(store: Store, repo: Repo, pr: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pr.merged) return 'UNKNOWN';
  const baseSha = prTip(repo, pr.base, pr.baseSha);
  const headSha = prTip(repo, pr.head, pr.headSha);
  const base = mergeBase(repo.objects, headSha, baseSha);
  if (base === null) return 'UNKNOWN';
  const baseTree = treeOfCommit(repo, base);
  const headTree = treeOfCommit(repo, headSha);
  const tipTree = treeOfCommit(repo, baseSha);
  const headChanges = diffTrees(repo.objects, baseTree, headTree);
  const baseChanges = diffTrees(repo.objects, baseTree, tipTree);
  const baseChanged = new Map(baseChanges.map((c) => [c.path, c.headOid]));
  for (const c of headChanges) {
    if (baseChanged.has(c.path) && baseChanged.get(c.path) !== c.headOid) {
      return 'CONFLICTING';
    }
  }
  return 'MERGEABLE';
}

function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Squash-merge a pull request onto its base branch. Returns the merge
 *  commit sha and message. Throws 404 / 405 (already merged / conflict). */
export function mergePull(store: Store, repo: Repo, pr: Pull): { sha: string; message: string } {
  if (pr.merged) {
    throw new ApiError(405, 'Pull request is already merged.');
  }
  if (pullMergeable(store, repo, pr) === 'CONFLICTING') {
    throw new ApiError(405, 'Merge conflict.');
  }
  const baseSha = prTip(repo, pr.base, pr.baseSha);
  const headSha = prTip(repo, pr.head, pr.headSha);
  const base = mergeBase(repo.objects, headSha, baseSha);
  const baseTree = base ? treeOfCommit(repo, base) : null;
  const headTree = treeOfCommit(repo, headSha);
  const tipTree = treeOfCommit(repo, baseSha);
  // Apply the head's changes (vs merge-base) onto the base tip tree.
  let newTree = tipTree;
  const headChanges = diffTrees(repo.objects, baseTree, headTree);
  for (const c of headChanges) {
    if (c.headOid === null) {
      newTree = treeDelete(repo.objects, newTree, pathSegments(c.path));
    } else {
      newTree = treeSet(repo.objects, newTree, pathSegments(c.path), c.headOid);
    }
  }
  if (newTree === null) {
    const { oid } = makeObject('tree', buildTree([]));
    repo.objects.set(oid, { type: 'tree', data: buildTree([]) });
    newTree = oid;
  }
  const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.head}`;
  const commitData = buildCommit(newTree, [baseSha], message);
  const { oid: mergeSha, obj } = makeObject('commit', commitData);
  repo.objects.set(mergeSha, obj);
  repo.refs.set(branchRefName(repo, pr.base), mergeSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = isoFromSeq(store.nextSeq());
  pr.mergeCommitSha = mergeSha;
  return { sha: mergeSha, message };
}

// ---------------------------------------------------------------------------
// Contents (PUT / GET / DELETE)
// ---------------------------------------------------------------------------

export interface ContentResult {
  blobSha: string;
  commitSha: string;
  isNew: boolean;
}

/** Create or update a file on a branch. `contentB64` is base64 file bytes. */
export function putContent(
  store: Store,
  repo: Repo,
  input: { path: string; message: string; contentB64: string; sha?: string; branch?: string },
): ContentResult {
  const segments = pathSegments(input.path);
  if (segments.length === 0) throw new ApiError(422, 'Invalid path.');
  const branch = input.branch ?? repo.defaultBranch;
  const refName = branchRefName(repo, branch);
  let tip = repo.refs.get(refName);
  if (!tip) {
    if (repo.refs.size === 0) {
      tip = null; // unborn: first commit creates the branch
    } else {
      // Branch does not exist: create it from the default tip.
      const defaultRef = defaultTip(repo);
      if (!defaultRef) throw new ApiError(404, `Branch '${branch}' not found.`);
      tip = defaultRef;
    }
  }
  const tipTree = tip ? treeOfCommit(repo, tip) : null;
  const existing = tipTree ? treeGet(repo.objects, tipTree, segments) : null;
  if (input.sha && existing && existing.oid !== input.sha) {
    throw new ApiError(409, 'sha does not match the current file.');
  }
  if (input.sha && !existing) {
    throw new ApiError(409, 'sha does not match the current file.');
  }
  const isNew = !existing;
  const bytes = b64decode(input.contentB64);
  const { oid: blobSha, obj: blobObj } = makeObject('blob', bytes);
  repo.objects.set(blobSha, blobObj);
  const newTree = treeSet(repo.objects, tipTree, segments, blobSha);
  const parents = tip ? [tip] : [];
  const commitData = buildCommit(newTree, parents, input.message);
  const { oid: commitSha, obj: commitObj } = makeObject('commit', commitData);
  repo.objects.set(commitSha, commitObj);
  repo.refs.set(refName, commitSha);
  return { blobSha, commitSha, isNew };
}

export function deleteContent(
  store: Store,
  repo: Repo,
  input: { path: string; message: string; sha?: string; branch?: string },
): { commitSha: string } {
  const segments = pathSegments(input.path);
  if (segments.length === 0) throw new ApiError(422, 'Invalid path.');
  const branch = input.branch ?? repo.defaultBranch;
  const refName = branchRefName(repo, branch);
  const tip = repo.refs.get(refName);
  if (!tip) throw new ApiError(404, `Branch '${branch}' not found.`);
  const tipTree = treeOfCommit(repo, tip);
  const existing = tipTree ? treeGet(repo.objects, tipTree, segments) : null;
  if (!existing) throw new ApiError(404, 'File not found.');
  if (input.sha && existing.oid !== input.sha) {
    throw new ApiError(409, 'sha does not match the current file.');
  }
  let newTree = treeDelete(repo.objects, tipTree, segments);
  if (newTree === null) {
    const empty = buildTree([]);
    const { oid } = makeObject('tree', empty);
    repo.objects.set(oid, { type: 'tree', data: empty });
    newTree = oid;
  }
  const commitData = buildCommit(newTree, [tip], input.message);
  const { oid: commitSha, obj: commitObj } = makeObject('commit', commitData);
  repo.objects.set(commitSha, commitObj);
  repo.refs.set(refName, commitSha);
  return { commitSha };
}

export interface ContentEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
}

export interface ContentFile {
  type: 'file';
  name: string;
  path: string;
  sha: string;
  size: number;
  encoding: 'base64';
  content: string;
}

/** Read a path at a ref (branch name or commit oid). Returns a file, a
 *  directory listing, or null when the path does not exist. */
export function getContent(
  repo: Repo,
  path: string,
  ref?: string,
): ContentFile | ContentEntry[] | null {
  const tip = resolveRef(repo, ref);
  if (!tip) return null;
  const tipTree = treeOfCommit(repo, tip);
  if (!tipTree) return null;
  const segments = pathSegments(path);
  if (segments.length === 0) {
    return listDir(repo, tipTree, '');
  }
  const entry = treeGet(repo.objects, tipTree, segments);
  if (!entry) return null;
  if (entry.mode === '40000') {
    return listDir(repo, entry.oid, segments.join('/'));
  }
  const obj = repo.objects.get(entry.oid);
  if (!obj || obj.type !== 'blob') return null;
  return {
    type: 'file',
    name: segments[segments.length - 1],
    path: segments.join('/'),
    sha: entry.oid,
    size: obj.data.length,
    encoding: 'base64',
    content: b64encode(obj.data),
  };
}

function listDir(repo: Repo, treeOid: string, prefix: string): ContentEntry[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const out: ContentEntry[] = [];
  for (const e of parseTree(obj.data)) {
    out.push({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: prefix ? `${prefix}/${e.name}` : e.name,
      sha: e.oid,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// REST view helpers (plain JSON shapes)
// ---------------------------------------------------------------------------

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoFromSeq(repo.createdSeq),
    updated_at: isoFromSeq(repo.createdSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name);
      return { name, color: l ? l.color : '000000' };
    }),
    created_at: isoFromSeq(issue.createdSeq),
    updated_at: isoFromSeq(issue.updatedSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(store: Store, repo: Repo, pr: Pull): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'closed' : pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.head, sha: prTip(repo, pr.head, pr.headSha), label: `${repo.owner}:${pr.head}` },
    base: { ref: pr.base, sha: prTip(repo, pr.base, pr.baseSha), label: `${repo.owner}:${pr.base}` },
    created_at: isoFromSeq(pr.createdSeq),
    updated_at: isoFromSeq(pr.createdSeq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

