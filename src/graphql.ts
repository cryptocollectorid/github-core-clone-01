// GraphQL v4 endpoint: a hand-rolled parser + executor for the document
// shapes `gh` and `github-mcp-server` send. Supports queries, mutations,
// variables, aliases, arguments (literals, variables, inline objects and
// lists), inline fragments, __type introspection, batch arrays, and
// cursor pagination. Unknown fields produce a GraphQL error naming the
// field (HTTP 200), as GitHub does.

import {
  ApiError,
  createComment,
  createIssue,
  createPull,
  getIssue,
  getPull,
  mergePull,
  pullFiles,
  pullMergeable,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { decodeGlobalId, globalId, isoFromSeq } from './util.ts';
import type { RestRequest, RestResponse } from './rest.ts';

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionSet | null;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition: string | null;
  selection: SelectionSet;
}

type Selection = FieldNode | InlineFragmentNode;
type SelectionSet = Selection[];

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selection: SelectionSet;
}

class GqlParser {
  private pos = 0;
  private src: string;
  constructor(src: string) {
    this.src = src;
  }

  private skipWS(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
        this.pos++;
      } else if (c === '#') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
      } else {
        break;
      }
    }
  }

  private peek(): string {
    this.skipWS();
    return this.src[this.pos] ?? '';
  }

  private consume(ch: string): boolean {
    this.skipWS();
    if (this.src[this.pos] === ch) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(ch: string): void {
    if (!this.consume(ch)) throw new Error(`Expected '${ch}' at offset ${this.pos}`);
  }

  private parseName(): string {
    this.skipWS();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos));
    if (!m) throw new Error(`Expected a name at offset ${this.pos}`);
    this.pos += m[0].length;
    return m[0];
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++];
      if (c === '"') return out;
      if (c === '\\') {
        const e = this.src[this.pos++];
        if (e === 'n') out += '\n';
        else if (e === 't') out += '\t';
        else if (e === 'r') out += '\r';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === 'u') {
          out += String.fromCharCode(parseInt(this.src.slice(this.pos, this.pos + 4), 16));
          this.pos += 4;
        } else out += e;
      } else {
        out += c;
      }
    }
    throw new Error('Unterminated string');
  }

  private parseValue(): ValueNode {
    this.skipWS();
    const c = this.src[this.pos];
    if (c === '$') {
      this.pos++;
      return { kind: 'variable', name: this.parseName() };
    }
    if (c === '"') return { kind: 'literal', value: this.parseString() };
    if (c === '[') {
      this.pos++;
      const items: ValueNode[] = [];
      while (!this.consume(']')) {
        items.push(this.parseValue());
      }
      return { kind: 'literal', value: items };
    }
    if (c === '{') {
      this.pos++;
      const obj: Record<string, ValueNode> = {};
      while (!this.consume('}')) {
        const key = this.parseName();
        this.expect(':');
        obj[key] = this.parseValue();
      }
      return { kind: 'literal', value: obj };
    }
    const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(this.src.slice(this.pos));
    if (m) {
      this.pos += m[0].length;
      const n = Number(m[0]);
      return { kind: 'literal', value: Number.isInteger(n) ? n : n };
    }
    const name = this.parseName();
    if (name === 'true') return { kind: 'literal', value: true };
    if (name === 'false') return { kind: 'literal', value: false };
    if (name === 'null') return { kind: 'literal', value: null };
    return { kind: 'literal', value: name }; // enum value
  }

  /** Resolve a value node against the request variables (recursively). */
  resolveValue(node: ValueNode, variables: Record<string, unknown> = {}): unknown {
    if (node.kind === 'variable') {
      return node.name in variables ? variables[node.name] : null;
    }
    const v = node.value;
    if (Array.isArray(v)) return v.map((item) => this.resolveValue(item, variables));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, ValueNode>)) {
        out[k] = this.resolveValue(child, variables);
      }
      return out;
    }
    return v;
  }

  private parseType(): void {
    // Loosely consume a type token: Name, [Type], and trailing ! marks.
    this.skipWS();
    if (this.consume('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.parseName();
    }
    this.consume('!');
  }

  private parseDirectives(): void {
    while (this.peek() === '@') {
      this.pos++;
      this.parseName();
      if (this.peek() === '(') this.parseArguments();
    }
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    this.expect('(');
    while (!this.consume(')')) {
      const name = this.parseName();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseVariableDefinitions(): void {
    if (this.peek() !== '(') return;
    this.pos++;
    while (!this.consume(')')) {
      this.expect('$');
      this.parseName();
      this.expect(':');
      this.parseType();
      if (this.consume('=')) this.parseValue();
    }
  }

  private parseSelectionSet(): SelectionSet {
    const selections: SelectionSet = [];
    this.expect('{');
    while (!this.consume('}')) {
      if (this.peek() === '') throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    this.skipWS();
    if (this.src.startsWith('...', this.pos)) {
      this.pos += 3;
      this.skipWS();
      // Inline fragment: "... on Type { ... }" (fragment spreads unsupported).
      if (this.src.startsWith('on', this.pos) && !/[A-Za-z0-9_]/.test(this.src[this.pos + 2] ?? '')) {
        this.pos += 2;
        const typeCondition = this.parseName();
        this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.parseName();
      throw new Error(`Fragment spread "...${name}" is not supported`);
    }
    const first = this.parseName();
    let alias: string | null = null;
    let name = first;
    if (this.consume(':')) {
      alias = first;
      name = this.parseName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek() === '(') args = this.parseArguments();
    this.parseDirectives();
    let selection: SelectionSet | null = null;
    if (this.peek() === '{') selection = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selection };
  }

  parseDocument(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (true) {
      this.skipWS();
      if (this.pos >= this.src.length) break;
      if (this.peek() === '{') {
        ops.push({ operation: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.parseName();
      if (keyword !== 'query' && keyword !== 'mutation') {
        throw new Error(`Unsupported operation keyword '${keyword}'`);
      }
      let name: string | null = null;
      this.skipWS();
      if (this.pos < this.src.length && this.src[this.pos] !== '(' && this.src[this.pos] !== '{' && this.src[this.pos] !== '@') {
        name = this.parseName();
      }
      this.parseVariableDefinitions();
      this.parseDirectives();
      ops.push({ operation: keyword, name, selection: this.parseSelectionSet() });
    }
    if (ops.length === 0) throw new Error('Empty document');
    return ops;
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface GqlObject {
  __typename: string;
  value: unknown;
}

function wrap(typename: string, value: unknown): GqlObject {
  return { __typename: typename, value };
}

interface Ctx {
  store: Store;
}

type Errors = Array<{ message: string }>;

function resolveValueNode(node: ValueNode, variables: Record<string, unknown>): unknown {
  if (node.kind === 'variable') {
    return node.name in variables ? variables[node.name] : null;
  }
  const v = node.value;
  if (Array.isArray(v)) return v.map((item) => resolveValueNode(item, variables));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, child] of Object.entries(v as Record<string, ValueNode>)) {
      out[k] = resolveValueNode(child, variables);
    }
    return out;
  }
  return v;
}

function argValue(field: FieldNode, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValueNode(arg.value, variables);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', `${repo.owner}/${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`);
}

function pullGlobalId(repo: Repo, pr: Pull): string {
  return globalId('PullRequest', `${repo.owner}/${repo.name}#${pr.number}`);
}

function cursorFor(n: number): string {
  return Buffer.from(String(n), 'utf8').toString('base64');
}

function cursorToNumber(cursor: string): number | null {
  try {
    const n = parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

interface PageInput {
  first?: number;
  after?: string;
}

function paginateNodes<T>(items: T[], input: PageInput, keyOf: (item: T) => number): {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
} {
  let start = 0;
  if (input.after) {
    const afterKey = cursorToNumber(input.after);
    if (afterKey !== null) {
      const idx = items.findIndex((it) => keyOf(it) === afterKey);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof input.first === 'number' && input.first >= 0 ? input.first : items.length;
  const nodes = items.slice(start, start + first);
  const end = start + nodes.length;
  return {
    nodes,
    pageInfo: {
      hasNextPage: end < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length > 0 ? cursorFor(keyOf(nodes[0])) : null,
      endCursor: nodes.length > 0 ? cursorFor(keyOf(nodes[nodes.length - 1])) : null,
    },
  };
}

const TYPE_REGISTRY: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; enumValues?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'headRef', 'baseRef', 'mergedAt', 'url', 'createdAt', 'author'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate', 'createdAt', 'defaultBranch'],
  },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'MILESTONE', 'ORGANIZATION', 'PULL_REQUEST', 'CODE', 'COMMIT', 'LABEL'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'WRITE', 'READ', 'MAINTAIN', 'TRIAGE', 'NONE'] },
};

function findRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== ctx.store.viewerLogin) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function findIssueByGlobalId(ctx: Ctx, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const m = /^(.+?)\/(.+?)#(\d+)$/.exec(decoded.key);
  if (!m) return null;
  const repo = findRepo(ctx, m[1], m[2]);
  if (!repo) return null;
  const issue = repo.issues.get(parseInt(m[3], 10));
  return issue ? { repo, issue } : null;
}

function findPullByGlobalId(ctx: Ctx, id: string): { repo: Repo; pr: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const m = /^(.+?)\/(.+?)#(\d+)$/.exec(decoded.key);
  if (!m) return null;
  const repo = findRepo(ctx, m[1], m[2]);
  if (!repo) return null;
  const pr = repo.pulls.get(parseInt(m[3], 10));
  return pr ? { repo, pr } : null;
}

function findRepoByGlobalId(ctx: Ctx, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const m = /^(.+?)\/(.+)$/.exec(decoded.key);
  if (!m) return null;
  return findRepo(ctx, m[1], m[2]);
}

/** Resolve one field on a wrapped object. Returns a scalar, a GqlObject, an
 *  array of GqlObjects, or null. Throws ApiError for lookup failures. */
function resolveField(ctx: Ctx, obj: GqlObject, field: FieldNode, variables: Record<string, unknown>): unknown {
  const name = field.name;
  const type = obj.__typename;

  if (name === '__typename') return type;

  if (type === 'Query') {
    if (name === 'viewer') {
      return wrap('User', { login: ctx.store.viewerLogin, id: 1000 });
    }
    if (name === 'repository') {
      const owner = String(argValue(field, 'owner', variables) ?? '');
      const repoName = String(argValue(field, 'name', variables) ?? '');
      const repo = findRepo(ctx, owner, repoName);
      return repo ? wrap('Repository', repo) : null;
    }
    if (name === 'node') {
      const id = String(argValue(field, 'id', variables) ?? '');
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'Repository') {
        const repo = findRepoByGlobalId(ctx, id);
        return repo ? wrap('Repository', repo) : null;
      }
      if (decoded.kind === 'Issue') {
        const found = findIssueByGlobalId(ctx, id);
        return found ? wrap('Issue', { repo: found.repo, issue: found.issue }) : null;
      }
      if (decoded.kind === 'PullRequest') {
        const found = findPullByGlobalId(ctx, id);
        return found ? wrap('PullRequest', { repo: found.repo, pr: found.pr }) : null;
      }
      if (decoded.kind === 'IssueComment') {
        const m = /^(.+?)\/(.+?)#(\d+):(\d+)$/.exec(decoded.key);
        if (!m) return null;
        const repo = findRepo(ctx, m[1], m[2]);
        const issue = repo?.issues.get(parseInt(m[3], 10));
        const comment = issue?.comments.find((c) => c.id === parseInt(m[4], 10));
        return comment ? wrap('IssueComment', { repo, issue, comment }) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(argValue(field, 'name', variables) ?? '');
      const entry = TYPE_REGISTRY[typeName];
      if (!entry) return null;
      return wrap('__Type', { name: typeName, kind: entry.kind, fields: entry.fields ?? [], enumValues: entry.enumValues ?? [] });
    }
    return undefined; // unknown field
  }

  if (type === 'Mutation') {
    if (name === 'createIssue') {
      const input = asRecord(argValue(field, 'input', variables));
      const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (!repo) throw new ApiError(404, 'Repository not found.');
      const issue = createIssue(ctx.store, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      return wrap('CreateIssuePayload', { issue: wrap('Issue', { repo, issue }) });
    }
    if (name === 'closeIssue') {
      const input = asRecord(argValue(field, 'input', variables));
      const found = findIssueByGlobalId(ctx, String(input.issueId ?? ''));
      if (!found) throw new ApiError(404, 'Issue not found.');
      found.issue.state = 'closed';
      found.issue.updatedSeq = ctx.store.nextSeq();
      return wrap('CloseIssuePayload', { issue: wrap('Issue', found) });
    }
    if (name === 'createPullRequest') {
      const input = asRecord(argValue(field, 'input', variables));
      const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (!repo) throw new ApiError(404, 'Repository not found.');
      const pr = createPull(ctx.store, repo, {
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      return wrap('CreatePullRequestPayload', { pullRequest: wrap('PullRequest', { repo, pr }) });
    }
    if (name === 'mergePullRequest') {
      const input = asRecord(argValue(field, 'input', variables));
      const found = findPullByGlobalId(ctx, String(input.pullRequestId ?? ''));
      if (!found) throw new ApiError(404, 'Pull request not found.');
      mergePull(ctx.store, found.repo, found.pr);
      return wrap('MergePullRequestPayload', { pullRequest: wrap('PullRequest', found) });
    }
    if (name === 'addComment') {
      const input = asRecord(argValue(field, 'input', variables));
      const found = findIssueByGlobalId(ctx, String(input.subjectId ?? ''));
      if (!found) throw new ApiError(404, 'Issue not found.');
      const comment = createComment(ctx.store, found.repo, found.issue.number, String(input.body ?? ''));
      return wrap('AddCommentPayload', {
        commentEdge: wrap('IssueCommentEdge', {
          node: wrap('IssueComment', { repo: found.repo, issue: found.issue, comment }),
          cursor: cursorFor(comment.id),
        }),
      });
    }
    return undefined;
  }

  if (type === 'User') {
    const user = obj.value as { login: string; id: number };
    if (name === 'login') return user.login;
    if (name === 'id') return user.id;
    if (name === 'name') return user.login;
    if (name === 'email') return `${user.login}@example.invalid`;
    if (name === 'url') return `https://github.com/${user.login}`;
    return undefined;
  }

  if (type === 'Repository') {
    const repo = obj.value as Repo;
    if (name === 'id') return repoGlobalId(repo);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'owner') return wrap('User', { login: repo.owner, id: 1000 });
    if (name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip ? wrap('BranchRef', { name: repo.defaultBranch }) : null;
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'description') return repo.description;
    if (name === 'isPrivate') return repo.isPrivate;
    if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
    if (name === 'createdAt') return isoFromSeq(repo.createdSeq);
    if (name === 'defaultBranch') return repo.defaultBranch;
    if (name === 'issue') {
      const number = argValue(field, 'number', variables);
      const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
      return issue ? wrap('Issue', { repo, issue }) : null;
    }
    if (name === 'issues') {
      const states = argValue(field, 'states', variables) as string[] | undefined;
      const orderBy = asRecord(argValue(field, 'orderBy', variables));
      const first = argValue(field, 'first', variables);
      const after = argValue(field, 'after', variables);
      let list = [...repo.issues.values()];
      const wanted = states && states.length > 0 ? new Set(states.map((s) => String(s).toLowerCase())) : new Set(['open']);
      list = list.filter((i) => wanted.has(i.state));
      const orderField = String(orderBy.field ?? 'CREATED_AT');
      const direction = String(orderBy.direction ?? 'DESC');
      const keyOf = (i: Issue): number =>
        orderField === 'UPDATED_AT' ? i.updatedSeq : orderField === 'COMMENTS' ? i.comments.length : i.createdSeq;
      list.sort((a, b) => (direction === 'ASC' ? keyOf(a) - keyOf(b) : keyOf(b) - keyOf(a)));
      const page = paginateNodes(list, { first: typeof first === 'number' ? first : undefined, after: typeof after === 'string' ? after : undefined }, (i) => i.number);
      return wrap('IssueConnection', {
        nodes: page.nodes.map((i) => wrap('Issue', { repo, issue: i })),
        pageInfo: page.pageInfo,
        totalCount: list.length,
      });
    }
    if (name === 'pullRequests') {
      const first = argValue(field, 'first', variables);
      const after = argValue(field, 'after', variables);
      const states = argValue(field, 'states', variables) as string[] | undefined;
      let list = [...repo.pulls.values()];
      if (states && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toUpperCase()));
        list = list.filter((pr) => wanted.has(pr.merged ? 'MERGED' : pr.state.toUpperCase()));
      } else {
        list = list.filter((pr) => pr.state === 'open');
      }
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      const page = paginateNodes(list, { first: typeof first === 'number' ? first : undefined, after: typeof after === 'string' ? after : undefined }, (pr) => pr.number);
      return wrap('PullRequestConnection', {
        nodes: page.nodes.map((pr) => wrap('PullRequest', { repo, pr })),
        pageInfo: page.pageInfo,
        totalCount: list.length,
      });
    }
    if (name === 'pullRequest') {
      const number = argValue(field, 'number', variables);
      const pr = typeof number === 'number' ? repo.pulls.get(number) : undefined;
      return pr ? wrap('PullRequest', { repo, pr }) : null;
    }
    return undefined;
  }

  if (type === 'BranchRef') {
    const v = obj.value as { name: string };
    if (name === 'name') return v.name;
    return undefined;
  }

  if (type === 'Issue') {
    const { repo, issue } = obj.value as { repo: Repo; issue: Issue };
    if (name === 'id') return issueGlobalId(repo, issue);
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'body') return issue.body;
    if (name === 'state') return issue.state.toUpperCase();
    if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    if (name === 'createdAt') return isoFromSeq(issue.createdSeq);
    if (name === 'updatedAt') return isoFromSeq(issue.updatedSeq);
    return undefined;
  }

  if (type === 'IssueConnection') {
    const v = obj.value as { nodes: GqlObject[]; pageInfo: unknown; totalCount: number };
    if (name === 'nodes') return v.nodes;
    if (name === 'edges') {
      return v.nodes.map((n) => {
        const issue = (n.value as { issue: Issue }).issue;
        return wrap('IssueEdge', { node: n, cursor: cursorFor(issue.number) });
      });
    }
    if (name === 'pageInfo') return wrap('PageInfo', v.pageInfo);
    if (name === 'totalCount') return v.totalCount;
    return undefined;
  }

  if (type === 'IssueEdge') {
    const v = obj.value as { node: GqlObject; cursor: string };
    if (name === 'node') return v.node;
    if (name === 'cursor') return v.cursor;
    return undefined;
  }

  if (type === 'PullRequest') {
    const { repo, pr } = obj.value as { repo: Repo; pr: Pull };
    if (name === 'id') return pullGlobalId(repo, pr);
    if (name === 'number') return pr.number;
    if (name === 'title') return pr.title;
    if (name === 'body') return pr.body;
    if (name === 'state') return pr.merged ? 'MERGED' : pr.state.toUpperCase();
    if (name === 'merged') return pr.merged;
    if (name === 'mergeable') return pullMergeable(ctx.store, repo, pr);
    if (name === 'headRefName') return pr.head;
    if (name === 'baseRefName') return pr.base;
    if (name === 'headRef') return wrap('BranchRef', { name: pr.head });
    if (name === 'baseRef') return wrap('BranchRef', { name: pr.base });
    if (name === 'mergedAt') return pr.mergedAt;
    if (name === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`;
    if (name === 'createdAt') return isoFromSeq(pr.createdSeq);
    if (name === 'files') {
      const first = argValue(field, 'first', variables);
      const files = pullFiles(ctx.store, repo, pr);
      const limited = typeof first === 'number' ? files.slice(0, first) : files;
      return wrap('PullRequestChangedFileConnection', {
        nodes: limited.map((f) => wrap('PullRequestChangedFile', {
          path: f.filename,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })),
        totalCount: files.length,
      });
    }
    return undefined;
  }

  if (type === 'PullRequestConnection') {
    const v = obj.value as { nodes: GqlObject[]; pageInfo: unknown; totalCount: number };
    if (name === 'nodes') return v.nodes;
    if (name === 'edges') {
      return v.nodes.map((n) => {
        const pr = (n.value as { pr: Pull }).pr;
        return wrap('PullRequestEdge', { node: n, cursor: cursorFor(pr.number) });
      });
    }
    if (name === 'pageInfo') return wrap('PageInfo', v.pageInfo);
    if (name === 'totalCount') return v.totalCount;
    return undefined;
  }

  if (type === 'PullRequestEdge') {
    const v = obj.value as { node: GqlObject; cursor: string };
    if (name === 'node') return v.node;
    if (name === 'cursor') return v.cursor;
    return undefined;
  }

  if (type === 'PullRequestChangedFileConnection') {
    const v = obj.value as { nodes: GqlObject[]; totalCount: number };
    if (name === 'nodes') return v.nodes;
    if (name === 'totalCount') return v.totalCount;
    return undefined;
  }

  if (type === 'PullRequestChangedFile') {
    const f = obj.value as { path: string; additions: number; deletions: number; changes: number };
    if (name === 'path') return f.path;
    if (name === 'additions') return f.additions;
    if (name === 'deletions') return f.deletions;
    if (name === 'changes') return f.changes;
    return undefined;
  }

  if (type === 'PageInfo') {
    const v = obj.value as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
    if (name === 'hasNextPage') return v.hasNextPage;
    if (name === 'hasPreviousPage') return v.hasPreviousPage;
    if (name === 'startCursor') return v.startCursor;
    if (name === 'endCursor') return v.endCursor;
    return undefined;
  }

  if (type === '__Type') {
    const v = obj.value as { name: string; kind: string; fields: string[]; enumValues: string[] };
    if (name === 'name') return v.name;
    if (name === 'kind') return v.kind;
    if (name === 'fields') {
      return v.kind === 'OBJECT' ? v.fields.map((f) => wrap('__Field', { name: f })) : null;
    }
    if (name === 'enumValues') {
      return v.kind === 'ENUM' ? v.enumValues.map((e) => wrap('__EnumValue', { name: e })) : null;
    }
    return undefined;
  }

  if (type === '__Field' || type === '__EnumValue') {
    const v = obj.value as { name: string };
    if (name === 'name') return v.name;
    return undefined;
  }

  if (type === 'IssueComment') {
    const { repo, issue, comment } = obj.value as { repo: Repo; issue: Issue; comment: { id: number; body: string } };
    if (name === 'id') return globalId('IssueComment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`);
    if (name === 'body') return comment.body;
    return undefined;
  }

  if (type === 'IssueCommentEdge') {
    const v = obj.value as { node: GqlObject; cursor: string };
    if (name === 'node') return v.node;
    if (name === 'cursor') return v.cursor;
    return undefined;
  }

  // Mutation payloads: fields resolve to the wrapped property of the same name.
  if (type.endsWith('Payload')) {
    const v = obj.value as Record<string, unknown>;
    if (name in v) return v[name] as unknown;
    return undefined;
  }

  return undefined;
}

function isGqlObject(v: unknown): v is GqlObject {
  return v !== null && typeof v === 'object' && '__typename' in (v as Record<string, unknown>);
}

function executeSelection(
  ctx: Ctx,
  obj: GqlObject,
  selection: SelectionSet,
  variables: Record<string, unknown>,
  errors: Errors,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selection) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition && sel.typeCondition !== obj.__typename) continue;
      const sub = executeSelection(ctx, obj, sel.selection, variables, errors);
      Object.assign(out, sub);
      continue;
    }
    const key = sel.alias ?? sel.name;
    let resolved: unknown;
    try {
      resolved = resolveField(ctx, obj, sel, variables);
    } catch (e) {
      if (e instanceof ApiError) {
        errors.push({ message: e.message });
        out[key] = null;
        continue;
      }
      throw e;
    }
    if (resolved === undefined) {
      errors.push({ message: `Cannot query field "${sel.name}" on type "${obj.__typename}".` });
      out[key] = null;
      continue;
    }
    if (resolved === null) {
      out[key] = null;
      continue;
    }
    if (Array.isArray(resolved)) {
      out[key] = resolved.map((item) => {
        if (isGqlObject(item)) {
          return sel.selection ? executeSelection(ctx, item, sel.selection, variables, errors) : null;
        }
        return item;
      });
      continue;
    }
    if (isGqlObject(resolved)) {
      out[key] = sel.selection ? executeSelection(ctx, resolved, sel.selection, variables, errors) : null;
      continue;
    }
    out[key] = resolved;
  }
  return out;
}

export interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Errors;
}

export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | undefined,
): GraphQLResult {
  const ctx: Ctx = { store };
  let ops: OperationNode[];
  try {
    ops = new GqlParser(query).parseDocument();
  } catch (e) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${(e as Error).message}` }] };
  }
  let op: OperationNode | undefined;
  if (operationName) op = ops.find((o) => o.name === operationName);
  if (!op) op = ops[0];
  const root = wrap(op.operation === 'mutation' ? 'Mutation' : 'Query', null);
  const errors: Errors = [];
  const data = executeSelection(ctx, root, op.selection, variables, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

export function handleGraphQL(store: Store, token: string, req: RestRequest): RestResponse | null {
  if (req.path !== '/api/graphql' || req.method !== 'POST') return null;
  const auth = req.headers['authorization'] ?? '';
  if (auth !== `Bearer ${token}`) {
    return { status: 401, body: JSON.stringify({ message: 'Bad credentials' }) + '\n' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] }) + '\n' };
  }
  const runOne = (op: unknown): GraphQLResult => {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) {
      return { data: null, errors: [{ message: 'Invalid GraphQL operation.' }] };
    }
    const rec = op as Record<string, unknown>;
    const query = typeof rec.query === 'string' ? rec.query : '';
    const variables = asRecord(rec.variables);
    const operationName = typeof rec.operationName === 'string' ? rec.operationName : undefined;
    return executeGraphQL(store, query, variables, operationName);
  };
  const result = Array.isArray(parsed) ? parsed.map(runOne) : runOne(parsed);
  return { status: 200, body: JSON.stringify(result) + '\n' };
}
