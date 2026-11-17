// REST v3 API (GitHub-compatible surface used by the grading suite).
// All routes live under /api/v3 and require a valid Bearer token.
// Responses are JSON; every error body carries a string `message`.

import {
  ApiError,
  branchRefName,
  createComment,
  createIssue,
  createLabel,
  createPull,
  deleteContent,
  getContent,
  getIssue,
  getPull,
  issueJson,
  listIssues,
  mergePull,
  pullFiles,
  pullJson,
  putContent,
  repoJson,
  resolveRef,
  touchRefs,
  type Repo,
  type Store,
} from './store.ts';
import { firstParentChain, parseCommit } from './gitobj.ts';
import { isoFromSeq } from './util.ts';

export interface RestRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  host: string;
}

export interface RestResponse {
  status: number;
  /** JSON string (or null for a 204). The server adds the content-type. */
  body: string | null;
  headers?: Record<string, string>;
}

function json(status: number, value: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body: JSON.stringify(value) + '\n', headers };
}

function err(status: number, message: string): RestResponse {
  return json(status, { message });
}

function requireRepo(store: Store, owner: string, name: string): Repo {
  if (owner !== store.viewerLogin) throw new ApiError(404, 'Not Found');
  const repo = store.getRepo(owner, name);
  if (!repo) throw new ApiError(404, 'Not Found');
  return repo;
}

function parseJsonBody(req: RestRequest): Record<string, unknown> {
  if (req.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function pageParams(req: RestRequest): { perPage: number; page: number } {
  const perPageRaw = parseInt(req.query.get('per_page') ?? '', 10);
  const pageRaw = parseInt(req.query.get('page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  return { perPage, page };
}

function paginate<T>(items: T[], perPage: number, page: number): { pageItems: T[]; hasNext: boolean; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return {
    pageItems: items.slice(start, start + perPage),
    hasNext: page < totalPages,
    totalPages,
  };
}

function linkHeader(req: RestRequest, page: number, perPage: number, hasNext: boolean, totalPages: number): string | undefined {
  if (!hasNext && totalPages <= 1) return undefined;
  const build = (p: number): string => {
    const q = new URLSearchParams(req.query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `<http://${req.host}${req.path}?${q.toString()}>`;
  };
  const parts: string[] = [];
  if (hasNext) parts.push(`${build(page + 1)}; rel="next"`);
  if (totalPages > 1) parts.push(`${build(totalPages)}; rel="last"`);
  if (page > 1) parts.push(`${build(1)}; rel="first"`);
  if (page > 1) parts.push(`${build(page - 1)}; rel="prev"`);
  return parts.join(', ');
}

/** Handle a REST request. Returns null when the path is not /api/v3/*. */
export function handleRest(store: Store, token: string, req: RestRequest): RestResponse | null {
  if (!req.path.startsWith('/api/v3')) return null;
  try {
    // Auth: every /api/v3 route needs the suite token.
    const auth = req.headers['authorization'] ?? '';
    if (auth !== `Bearer ${token}`) {
      return err(401, 'Bad credentials');
    }
    return route(store, req);
  } catch (e) {
    if (e instanceof ApiError) return err(e.status, e.message);
    return err(500, `Internal error: ${(e as Error).message}`);
  }
}

function route(store: Store, req: RestRequest): RestResponse {
  const p = req.path;
  const m = req.method;
  const scopes = { 'X-OAuth-Scopes': 'repo, read:org' };

  // ---- Root / meta / user -------------------------------------------------
  if (p === '/api/v3/' && m === 'GET') {
    return json(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{user}',
    }, scopes);
  }
  if (p === '/api/v3/meta' && m === 'GET') {
    return json(200, { installed_version: '1.0.0' }, scopes);
  }
  if (p === '/api/v3/user' && m === 'GET') {
    return json(200, {
      login: store.viewerLogin,
      id: 1000,
      type: 'User',
      name: store.viewerLogin,
      email: `${store.viewerLogin}@example.invalid`,
      html_url: `https://github.com/${store.viewerLogin}`,
      url: '/api/v3/user',
    }, scopes);
  }

  // ---- POST /user/repos ----------------------------------------------------
  if (p === '/api/v3/user/repos' && m === 'POST') {
    const body = parseJsonBody(req);
    const name = str(body.name);
    if (!name) throw new ApiError(422, 'Validation Failed: name is required.');
    const repo = store.createRepo(name, {
      description: str(body.description) || undefined,
      isPrivate: body.private === true,
      defaultBranch: str(body.default_branch) || undefined,
    });
    return json(201, repoJson(store, repo), scopes);
  }

  // ---- GET /user/repos ------------------------------------------------------
  if (p === '/api/v3/user/repos' && m === 'GET') {
    const { perPage, page } = pageParams(req);
    const all = store.listRepos().map((r) => repoJson(store, r));
    const { pageItems, hasNext, totalPages } = paginate(all, perPage, page);
    const link = linkHeader(req, page, perPage, hasNext, totalPages);
    return json(200, pageItems, { ...scopes, ...(link ? { Link: link } : {}) });
  }

  // ---- /repos/{owner}/{name}... --------------------------------------------
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
  if (!repoMatch) {
    return err(404, 'Not Found');
  }
  const [, owner, name, rest] = repoMatch;
  const repo = requireRepo(store, owner, name);
  const sub = rest ?? '';

  // GET /repos/{o}/{r}
  if (sub === '' && m === 'GET') return json(200, repoJson(store, repo), scopes);
  // PATCH /repos/{o}/{r}
  if (sub === '' && m === 'PATCH') {
    const body = parseJsonBody(req);
    if (typeof body.description === 'string') repo.description = body.description;
    return json(200, repoJson(store, repo), scopes);
  }
  // DELETE /repos/{o}/{r}
  if (sub === '' && m === 'DELETE') {
    store.deleteRepo(owner, name);
    return { status: 204, body: null, headers: scopes };
  }

  // ---- branches -------------------------------------------------------------
  if (sub === '/branches' && m === 'GET') {
    const branches: Array<Record<string, unknown>> = [];
    for (const [ref, oid] of [...repo.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
    }
    return json(200, branches, scopes);
  }
  const branchMatch = /^\/branches\/([^/]+)$/.exec(sub);
  if (branchMatch && m === 'GET') {
    const oid = repo.refs.get(branchRefName(repo, branchMatch[1]));
    if (!oid) throw new ApiError(404, 'Branch not found.');
    return json(200, { name: branchMatch[1], commit: { sha: oid } }, scopes);
  }

  // ---- commits --------------------------------------------------------------
  if (sub === '/commits' && m === 'GET') {
    const shaParam = req.query.get('sha') ?? undefined;
    const tip = resolveRef(repo, shaParam);
    if (!tip) throw new ApiError(404, 'No commits found.');
    const chain = firstParentChain(repo.objects, tip);
    const out = chain.map((oid) => {
      const obj = repo.objects.get(oid);
      const parsed = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
      return {
        sha: oid,
        commit: {
          message: parsed?.message ?? '',
          author: { name: 'Conformance', email: 'conformance@make.fun', date: '2023-11-14T22:13:20Z' },
          committer: { name: 'Conformance', email: 'conformance@make.fun', date: '2023-11-14T22:13:20Z' },
        },
      };
    });
    return json(200, out, scopes);
  }

  // ---- git/refs ---------------------------------------------------------------
  const refGetMatch = /^\/git\/refs\/heads\/([^/]+)$/.exec(sub);
  if (refGetMatch && m === 'GET') {
    const oid = repo.refs.get(branchRefName(repo, refGetMatch[1]));
    if (!oid) throw new ApiError(404, 'Reference not found.');
    return json(200, { ref: `refs/heads/${refGetMatch[1]}`, object: { sha: oid, type: 'commit' } }, scopes);
  }
  if (sub === '/git/refs' && m === 'POST') {
    const body = parseJsonBody(req);
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (!ref.startsWith('refs/')) throw new ApiError(422, 'Validation Failed: ref must start with refs/.');
    if (!/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) {
      throw new ApiError(422, 'Validation Failed: sha does not exist.');
    }
    if (repo.refs.has(ref)) throw new ApiError(422, 'Validation Failed: reference already exists.');
    repo.refs.set(ref, sha);
    touchRefs(repo);
    return json(201, { ref, object: { sha, type: 'commit' } }, scopes);
  }

  // ---- contents ---------------------------------------------------------------
  const contentsMatch = /^\/contents\/?(.*)$/.exec(sub);
  if (contentsMatch) {
    const contentPath = decodeURIComponent(contentsMatch[1]);
    if (m === 'GET') {
      const ref = req.query.get('ref') ?? undefined;
      const found = getContent(repo, contentPath, ref);
      if (found === null) throw new ApiError(404, 'Not Found');
      return json(200, found, scopes);
    }
    if (m === 'PUT') {
      const body = parseJsonBody(req);
      const contentB64 = str(body.content);
      if (!contentB64) throw new ApiError(422, 'Validation Failed: content is required.');
      const result = putContent(store, repo, {
        path: contentPath,
        message: str(body.message) || `Update ${contentPath}`,
        contentB64,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
      });
      const size = Buffer.from(contentB64, 'base64').length;
      return json(result.isNew ? 201 : 200, {
        content: {
          name: contentPath.split('/').pop() ?? contentPath,
          path: contentPath,
          sha: result.blobSha,
          size,
          encoding: 'base64',
        },
        commit: { sha: result.commitSha, message: str(body.message) || `Update ${contentPath}` },
      }, scopes);
    }
    if (m === 'DELETE') {
      const body = parseJsonBody(req);
      const result = deleteContent(store, repo, {
        path: contentPath,
        message: str(body.message) || `Delete ${contentPath}`,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
      });
      return json(200, { commit: { sha: result.commitSha } }, scopes);
    }
  }

  // ---- labels -------------------------------------------------------------------
  if (sub === '/labels' && m === 'GET') {
    return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })), scopes);
  }
  if (sub === '/labels' && m === 'POST') {
    const body = parseJsonBody(req);
    const label = createLabel(repo, str(body.name), str(body.color) || '000000');
    return json(201, { name: label.name, color: label.color }, scopes);
  }

  // ---- issues --------------------------------------------------------------------
  if (sub === '/issues' && m === 'GET') {
    const { perPage, page } = pageParams(req);
    const list = listIssues(repo, {
      state: req.query.get('state') ?? undefined,
      direction: req.query.get('direction') ?? undefined,
    }).map((i) => issueJson(store, repo, i));
    const { pageItems, hasNext, totalPages } = paginate(list, perPage, page);
    const link = linkHeader(req, page, perPage, hasNext, totalPages);
    return json(200, pageItems, { ...scopes, ...(link ? { Link: link } : {}) });
  }
  if (sub === '/issues' && m === 'POST') {
    const body = parseJsonBody(req);
    const title = str(body.title);
    if (!title) throw new ApiError(422, 'Validation Failed: title is required.');
    const labels = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : undefined;
    const issue = createIssue(store, repo, { title, body: str(body.body), labels });
    return json(201, issueJson(store, repo, issue), scopes);
  }
  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(sub);
  if (issueMatch) {
    const number = parseInt(issueMatch[1], 10);
    const isComments = issueMatch[2] === '/comments';
    if (!isComments && m === 'GET') {
      return json(200, issueJson(store, repo, getIssue(repo, number)), scopes);
    }
    if (!isComments && m === 'PATCH') {
      const body = parseJsonBody(req);
      const issue = getIssue(repo, number);
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (typeof body.state === 'string') {
        if (body.state !== 'open' && body.state !== 'closed') {
          throw new ApiError(422, 'Validation Failed: invalid state.');
        }
        issue.state = body.state;
      }
      issue.updatedSeq = store.nextSeq();
      return json(200, issueJson(store, repo, issue), scopes);
    }
    if (isComments && m === 'GET') {
      const issue = getIssue(repo, number);
      return json(200, issue.comments.map((c) => ({
        id: c.id,
        body: c.body,
        created_at: isoFromSeq(c.createdSeq),
      })), scopes);
    }
    if (isComments && m === 'POST') {
      const body = parseJsonBody(req);
      const comment = createComment(store, repo, number, str(body.body));
      return json(201, { id: comment.id, body: comment.body, created_at: isoFromSeq(comment.createdSeq) }, scopes);
    }
  }

  // ---- pulls ----------------------------------------------------------------------
  if (sub === '/pulls' && m === 'GET') {
    const { perPage, page } = pageParams(req);
    const state = req.query.get('state') ?? 'open';
    let list = [...repo.pulls.values()];
    if (state !== 'all') {
      list = list.filter((pr) => (state === 'closed' ? pr.state === 'closed' : pr.state === 'open'));
    }
    list.sort((a, b) => b.createdSeq - a.createdSeq);
    const mapped = list.map((pr) => pullJson(store, repo, pr));
    const { pageItems, hasNext, totalPages } = paginate(mapped, perPage, page);
    const link = linkHeader(req, page, perPage, hasNext, totalPages);
    return json(200, pageItems, { ...scopes, ...(link ? { Link: link } : {}) });
  }
  if (sub === '/pulls' && m === 'POST') {
    const body = parseJsonBody(req);
    const pr = createPull(store, repo, {
      head: str(body.head),
      base: str(body.base),
      title: str(body.title),
      body: str(body.body),
    });
    return json(201, pullJson(store, repo, pr), scopes);
  }
  const pullFilesMatch = /^\/pulls\/(\d+)\/files$/.exec(sub);
  if (pullFilesMatch && m === 'GET') {
    const pr = getPull(repo, parseInt(pullFilesMatch[1], 10));
    return json(200, pullFiles(store, repo, pr), scopes);
  }
  const pullMergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(sub);
  if (pullMergeMatch && m === 'PUT') {
    const pr = getPull(repo, parseInt(pullMergeMatch[1], 10));
    const result = mergePull(store, repo, pr);
    return json(200, { sha: result.sha, merged: true, message: result.message }, scopes);
  }
  const pullMatch = /^\/pulls\/(\d+)$/.exec(sub);
  if (pullMatch && m === 'GET') {
    return json(200, pullJson(store, repo, getPull(repo, parseInt(pullMatch[1], 10))), scopes);
  }

  return err(404, 'Not Found');
}
