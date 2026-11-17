// HTTP server: reads each request body, routes it (healthz -> git smart
// HTTP -> REST v3 -> GraphQL -> MCP -> 404 JSON), and stamps every reply
// with a deterministic X-GitHub-Request-Id. Never crashes on a bad request.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestRequest, type RestResponse } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './gitserver.ts';

export interface AppOptions {
  token: string;
  viewerLogin: string;
}

const MAX_BODY = 64 * 1024 * 1024;

/** The Content-Length of a request, or null when absent/invalid. */
function parseContentLength(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function readBody(req: IncomingMessage, contentLength: number | null): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    let done = false;
    const finish = (buf: Buffer): void => {
      if (!done) {
        done = true;
        resolve(buf);
      }
    };
    req.on('data', (chunk: Buffer) => {
      if (failed || done) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total > MAX_BODY) {
        failed = true;
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      // The whole body arrived in the chunks so far: resolve now instead of
      // waiting a turn for the stream's 'end' event.
      if (contentLength !== null && total >= contentLength) {
        finish(Buffer.concat(chunks));
        req.resume();
      }
    });
    req.on('end', () => {
      if (!failed) finish(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (!failed) reject(e);
    });
  });
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string | null,
  body: Buffer | null,
  requestId: string,
  extraHeaders?: Record<string, string>,
): void {
  const headers: Record<string, string> = { 'X-GitHub-Request-Id': requestId };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  if (contentType) headers['Content-Type'] = contentType;
  if (body && body.length > 0) headers['Content-Length'] = String(body.length);
  res.writeHead(status, headers);
  res.end(body ?? undefined);
}

function sendRest(res: ServerResponse, r: RestResponse, requestId: string): void {
  if (r.status === 204) {
    send(res, 204, null, null, requestId, r.headers);
    return;
  }
  const body = r.body !== null ? Buffer.from(r.body, 'utf8') : Buffer.alloc(0);
  send(res, r.status, 'application/json; charset=utf-8', body, requestId, r.headers);
}

export function createApp(opts: AppOptions): { server: ReturnType<typeof createServer>; store: Store } {
  const store = new Store(opts.viewerLogin);
  let requestCounter = 0;

  /** Route one request and send its reply. Synchronous: every handler
   *  below is sync, so a request whose body is already known (or absent)
   *  is answered in the request tick, not a turn later. */
  const dispatch = (req: IncomingMessage, res: ServerResponse, body: Buffer, requestId: string): void => {
    const raw = req.url ?? '/';
    const q = raw.indexOf('?');
    const path = q < 0 ? raw : raw.slice(0, q);
    const query = q < 0 ? EMPTY_QUERY : new URLSearchParams(raw.slice(q + 1));
    const headers = req.headers as Record<string, string>;
    const host = req.headers.host ?? '127.0.0.1';
    const method = req.method ?? '';

    if (method === 'GET' && path === '/healthz') {
      send(res, 200, 'application/json; charset=utf-8', Buffer.from('{"ok": true}\n', 'utf8'), requestId);
      return;
    }

    const git = handleGit(store, {
      method,
      path,
      query,
      gitProtocol: headers['git-protocol'] ?? '',
      body,
    });
    if (git) {
      send(res, git.status, git.contentType, git.body, requestId);
      return;
    }

    const restReq: RestRequest = {
      method,
      path,
      query,
      headers,
      body,
      host,
    };
    const rest = handleRest(store, opts.token, restReq);
    if (rest) {
      sendRest(res, rest, requestId);
      return;
    }
    const gql = handleGraphQL(store, opts.token, restReq);
    if (gql) {
      sendRest(res, gql, requestId);
      return;
    }
    const mcp = handleMcp(store, opts.token, restReq);
    if (mcp) {
      sendRest(res, mcp, requestId);
      return;
    }
    send(res, 404, 'application/json; charset=utf-8', Buffer.from('{"message":"Not Found"}\n', 'utf8'), requestId);
  };

  const send500 = (res: ServerResponse, requestId: string, e: unknown): void => {
    try {
      send(
        res,
        500,
        'application/json; charset=utf-8',
        Buffer.from(JSON.stringify({ message: `Internal error: ${(e as Error).message}` }) + '\n', 'utf8'),
        requestId,
      );
    } catch {
      // The socket is gone; nothing more to do.
    }
  };

  const server = createServer((req, res) => {
    requestCounter += 1;
    const requestId = `req-${requestCounter}`;
    const contentLength = parseContentLength(req.headers['content-length']);
    const hasBody =
      (contentLength !== null && contentLength > 0) || req.headers['transfer-encoding'] !== undefined;
    if (!hasBody) {
      // No body can arrive: answer in this tick instead of spending a turn
      // waiting on the body stream's 'end' event.
      try {
        dispatch(req, res, Buffer.alloc(0), requestId);
      } catch (e) {
        send500(res, requestId, e);
      }
      return;
    }
    void (async () => {
      try {
        const body = await readBody(req, contentLength);
        dispatch(req, res, body, requestId);
      } catch (e) {
        send500(res, requestId, e);
      }
    })();
  });

  return { server, store };
}

/** Shared empty query set for requests without a '?'. Handlers only read
 *  it (`.get`), so one instance is enough. */
const EMPTY_QUERY = new URLSearchParams();
