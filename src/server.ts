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

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total > MAX_BODY) {
        failed = true;
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks));
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

  const server = createServer((req, res) => {
    void (async () => {
      requestCounter += 1;
      const requestId = `req-${requestCounter}`;
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const body = await readBody(req);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k.toLowerCase()] = v;
        }
        const host = req.headers.host ?? '127.0.0.1';
        const method = req.method ?? '';

        if (method === 'GET' && url.pathname === '/healthz') {
          send(res, 200, 'application/json; charset=utf-8', Buffer.from('{"ok": true}\n', 'utf8'), requestId);
          return;
        }

        const git = handleGit(store, {
          method,
          path: url.pathname,
          query: url.searchParams,
          gitProtocol: headers['git-protocol'] ?? '',
          body,
        });
        if (git) {
          send(res, git.status, git.contentType, git.body, requestId);
          return;
        }

        const restReq: RestRequest = {
          method,
          path: url.pathname,
          query: url.searchParams,
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
      } catch (e) {
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
      }
    })();
  });

  return { server, store };
}
