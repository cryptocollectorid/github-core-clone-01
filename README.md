# github-core-clone-01 — Mitecho Forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/cryptocollectorid/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/cryptocollectorid/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge in a single process, built for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01). No UI, no
outside service, its own in-memory store:

- **Clone and push over smart HTTP** (git protocol v0 and v2, `ls-refs`,
  shallow fetch, deepen/unshallow, fast-forward push with per-ref reports).
- **Repositories, issues, pull requests and contents over REST v3**
  (repos, branches, commits, git refs, contents, labels, issues, comments,
  pull requests, squash merge with a real 3-way conflict check).
- **GraphQL v4** — the query/mutation shapes `gh` and
  `github-mcp-server` send, including `__type` introspection, cursor
  pagination, and `node(id:)` with global ids.
- **MCP** — `server/discover` (modern era) + `initialize` (legacy) and the
  six canonical tools: `create_repo`, `get_repo`, `create_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request`.
- **Deterministic** — same seeded inputs give the same state export,
  byte for byte: fixed commit timestamps, logical counters for every
  id and REST timestamp, no wall clock, no randomness.

## Run

```sh
node main.ts
```

Requires Node ≥ 22.18 (type stripping, no build step) and the environment
the suite provides:

- `MAKEFUN_ENV_URL` — the suite endpoint to register the port with and
  poll for completion.
- `MAKEFUN_SHOP_TOKEN` — the Bearer token every API call carries.

The process binds an ephemeral port of its own (never 8080), registers it
with the suite, serves from its own store, and exits when the suite
reports done.

## Layout

- `main.ts` — lifecycle: bind, register, poll for done, exit.
- `src/server.ts` — HTTP server, routing, request ids, body reading.
- `src/store.ts` — in-memory store and the shared business logic
  (repos, issues, pull requests, labels, comments, contents, merge).
- `src/gitobj.ts` — git object model: pkt-lines, pack read/write,
  object parse/build, reachability, tree operations, line diff.
- `src/gitserver.ts` — smart HTTP: info/refs, ls-refs, fetch, push.
- `src/rest.ts` — REST v3 API.
- `src/graphql.ts` — GraphQL parser + executor.
- `src/mcp.ts` — MCP JSON-RPC endpoint and the six tools.
- `src/scenario.ts` — viewer identity derived from the fixed scenario seed.
- `src/util.ts` — deterministic helpers (ids, timestamps, hashing).

Standard library only. No dependencies, no git binary, no network at
runtime.

## License

MIT — see [LICENSE](LICENSE).
