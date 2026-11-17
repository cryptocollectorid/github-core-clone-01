// MCP endpoint (JSON-RPC 2.0 over plain JSON POST /mcp).
// Modern era via server/discover (no handshake/session), legacy initialize
// fallback, the six canonical tools, and JSON-RPC error codes for unknown
// methods/tools and missing arguments. Tools act on the same store as REST.

import {
  ApiError,
  createIssue,
  createPull,
  getIssue,
  getPull,
  issueJson,
  listIssues,
  mergePull,
  pullJson,
  repoJson,
  type Store,
} from './store.ts';
import { FORGE_NAME, FORGE_VERSION } from './util.ts';
import type { RestRequest, RestResponse } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const LEGACY_VERSIONS = [...SUPPORTED_VERSIONS, '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, string>>;
    required: string[];
  };
}

// Deterministic constant: byte-identical on every tools/list call.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function serverInfo(): { name: string; version: string } {
  return { name: FORGE_NAME, version: FORGE_VERSION };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function requireArgs(
  args: Record<string, unknown>,
  required: string[],
): void {
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      throw new ApiError(-32602, `Missing required argument: ${key}`);
    }
  }
}

function requireRepo(store: Store, owner: string, name: string) {
  if (owner !== store.viewerLogin) throw new ApiError(404, 'Repository not found.');
  const repo = store.getRepo(owner, name);
  if (!repo) throw new ApiError(404, 'Repository not found.');
  return repo;
}

/** Execute one tool and return its structured result object. */
function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      requireArgs(args, ['name']);
      const repo = store.createRepo(String(args.name), {
        description: typeof args.description === 'string' ? args.description : undefined,
        isPrivate: args.private === true,
      });
      // Include a `number` so the result carries a numeric identifier.
      return { ...repoJson(store, repo), number: repo.id };
    }
    case 'get_repo': {
      requireArgs(args, ['owner', 'repo']);
      const repo = requireRepo(store, String(args.owner), String(args.repo));
      return repoJson(store, repo);
    }
    case 'create_issue': {
      requireArgs(args, ['owner', 'repo', 'title']);
      const repo = requireRepo(store, String(args.owner), String(args.repo));
      const issue = createIssue(store, repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return issueJson(store, repo, issue);
    }
    case 'list_issues': {
      requireArgs(args, ['owner', 'repo']);
      const repo = requireRepo(store, String(args.owner), String(args.repo));
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = listIssues(repo, { state }).map((i) => issueJson(store, repo, i));
      return { issues };
    }
    case 'create_pull_request': {
      requireArgs(args, ['owner', 'repo', 'title', 'head', 'base']);
      const repo = requireRepo(store, String(args.owner), String(args.repo));
      const pr = createPull(store, repo, {
        head: String(args.head),
        base: String(args.base),
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return pullJson(store, repo, pr);
    }
    case 'merge_pull_request': {
      requireArgs(args, ['owner', 'repo', 'pull_number']);
      const repo = requireRepo(store, String(args.owner), String(args.repo));
      const number = Number(args.pull_number);
      const pr = getPull(repo, number);
      const result = mergePull(store, repo, pr);
      return { merged: true, sha: result.sha, number, state: 'closed' };
    }
    default:
      throw new ApiError(-32601, `Unknown tool: ${name}`);
  }
}

function handleOne(store: Store, request: unknown): { response: Record<string, unknown> | null; notification: boolean } {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { response: rpcError(null, -32600, 'Invalid Request'), notification: false };
  }
  const req = request as Record<string, unknown>;
  const id = 'id' in req ? req.id : undefined;
  const isNotification = id === undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params !== null && typeof req.params === 'object' ? req.params : {}) as Record<string, unknown>;

  if (method === 'notifications/initialized') {
    return { response: null, notification: true };
  }
  if (isNotification) {
    // Unknown notification: no response (JSON-RPC notifications are silent).
    return { response: null, notification: true };
  }

  if (method === 'server/discover') {
    return {
      response: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
        protocolVersion: '2026-07-28',
      }),
      notification: false,
    };
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = LEGACY_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return {
      response: rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: serverInfo(),
      }),
      notification: false,
    };
  }
  if (method === 'ping') {
    return { response: rpcResult(id, {}), notification: false };
  }
  if (method === 'tools/list') {
    return { response: rpcResult(id, { tools: TOOLS }), notification: false };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments !== null && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
    try {
      const value = callTool(store, toolName, args);
      return {
        response: rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        }),
        notification: false,
      };
    } catch (e) {
      if (e instanceof ApiError && (e.status === -32601 || e.status === -32602)) {
        return { response: rpcError(id, e.status, e.message), notification: false };
      }
      const message = e instanceof Error ? e.message : String(e);
      return {
        response: rpcResult(id, {
          content: [{ type: 'text', text: message }],
          structuredContent: { error: message },
          isError: true,
        }),
        notification: false,
      };
    }
  }
  return { response: rpcError(id, -32601, `Method not found: ${method}`), notification: false };
}

/** Handle POST /mcp. Returns null for any other path/method. */
export function handleMcp(store: Store, token: string, req: RestRequest): RestResponse | null {
  if (req.path !== '/mcp' || req.method !== 'POST') return null;
  const auth = req.headers['authorization'] ?? '';
  if (auth !== `Bearer ${token}`) {
    return {
      status: 401,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }) + '\n',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n',
    };
  }
  if (Array.isArray(parsed)) {
    const responses: Array<Record<string, unknown>> = [];
    for (const item of parsed) {
      const { response } = handleOne(store, item);
      if (response) responses.push(response);
    }
    return { status: 200, body: JSON.stringify(responses) + '\n' };
  }
  const { response, notification } = handleOne(store, parsed);
  if (notification || !response) {
    return { status: 202, body: null };
  }
  return { status: 200, body: JSON.stringify(response) + '\n' };
}
