# Drivo MCP

A secure, **domain-oriented** [Model Context Protocol](https://modelcontextprotocol.io) server for the
**Drivo — Dealer Business Platform** (Odoo-based DMS for vehicle inventory, CRM, deals, finance, service).
Works with Claude, ChatGPT, Cursor and any MCP client.

> Drivo MCP deliberately exposes **business tools** (`drivo_search_vehicles`, `drivo_create_lead`, …).
> There is no `odoo_execute_kw`, `odoo_write`, SQL, Python or shell tool, and there never will be.

Registry name: `biz.drivo/drivo-erp` · Remote endpoint: `https://mcp.drivo.biz/mcp`

## Architecture

```
MCP client (Claude / ChatGPT / Cursor)
        │  Streamable HTTP  (Authorization: Bearer <MCP key>)   or   stdio
        ▼
┌───────────────────────── Drivo MCP ─────────────────────────┐
│ authN → scope check → zod validation → company scope        │
│ → rate limit → [confirmation] → [idempotency] → handler     │
│ → company filter → internal-figure stripping → audit        │
└───────────────┬─────────────────────────────────────────────┘
                │  HTTPS, per-principal Drivo bearer token
                ▼
        Drivo API / service layer  (/api/v1/*, RBAC + company scope)
                ▼
        Odoo ORM / business logic  →  PostgreSQL   (never reachable from MCP)
```

## Tools

| Tool | Scope | Kind |
|---|---|---|
| `drivo_search_vehicles` / `drivo_get_vehicle` | `drivo.vehicle.read` | read |
| `drivo_search_customers` / `drivo_get_customer` | `drivo.customer.read` | read |
| `drivo_search_leads` / `drivo_get_lead` | `drivo.crm.read` | read |
| `drivo_create_lead` | `drivo.crm.write` | write (idempotent) |
| `drivo_search_deals` / `drivo_get_deal` | `drivo.sale.read` | read |
| `drivo_create_booking` | `drivo.sale.write` | **high-risk write** (confirmation + idempotent) |
| `drivo_get_payments` | `drivo.finance.read` | read |
| `drivo_get_service_history` | `drivo.service.read` | read |
| `drivo_create_service_booking` | `drivo.service.write` | write (idempotent) |
| `drivo_dashboard_kpis`, `drivo_attention_center` | `drivo.sale.read` | read |

Resources: `drivo://vehicle/{id}`, `drivo://customer/{id}` (same authorisation path as the tools).
`drivo.admin` implies all scopes but **never** bypasses company scope.

## Security model

- **AuthN**: `Authorization: Bearer <key>` or `X-API-Key`. Keys are matched by SHA-256 hash, constant-time.
- **AuthZ**: per-tool scope. **Upstream RBAC stays authoritative**: each principal maps to a dedicated Drivo
  user whose bearer token is used for every upstream call, so Drivo's own role + company rules apply.
- **Company isolation**: a principal has a company allowlist. A call naming another company is refused
  before any upstream request; responses are additionally filtered/denied if any record carries a
  `company_id` outside the active company (foreign records surface as `not_found`).
  *Limitation:* the Drivo API derives company from the token's user, so `company_id` acts as an
  assertion + filter, not a switch. Use one principal (user) per company for multi-company dealers.
- **Writes**: `idempotency_key` required (replays return the stored result; same key + different args →
  `idempotency_conflict`; failures are not cached; writes are never auto-retried).
- **High-risk writes** (`drivo_create_booking`): step 1 returns a preview and an HMAC-signed 5-minute
  token bound to principal + tool + exact arguments; step 2 repeats the call with the token.
- **Output hygiene**: cost / landed cost / commission / margin / profit fields are stripped unless the
  principal holds `drivo.finance.read`.
- **Safe errors**: clients only see stable error codes and short messages; upstream bodies, stack
  traces, hostnames and tokens never leave the server.
- **Audit**: one structured JSON event per call (request id, principal, user, company, tool, outcome,
  duration, idempotency key, redacted + length-capped input). Secrets are redacted by key and value shape.
- **Rate limiting**: per-principal read and write budgets (pluggable `RateLimiter`), plus per-IP
  throttling of failed authentication.
- Transport guards: Host/Origin allowlists, 1 MB body cap, stateless sessions.

See [SECURITY.md](SECURITY.md).

## Install & configure

Requires Node ≥ 20.

```bash
npm ci
cp .env.example .env                       # fill in; never commit
cp principals.example.json principals.json # never commit
npm run hash-key                           # prints a new key + its hash for principals.json
```

`principals.json` entry fields: `id`, `keyHash`, `userId`, `scopes[]`, `companyIds[]`,
`defaultCompanyId`, `upstreamTokenEnv` (name of the env var holding that principal's Drivo bearer
token, obtained from `POST /api/v1/auth/login` for a least-privilege Drivo user).

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DRIVO_API_BASE_URL` | ✔ | Drivo API base, e.g. `https://demo.drivo.biz` |
| `DRIVO_MCP_PRINCIPALS_FILE` | ✔ | Path to principals JSON |
| `DRIVO_MCP_CONFIRM_SECRET` | ✔ | ≥16-char secret signing confirmation tokens |
| `<upstreamTokenEnv>` | ✔ | One per principal: its Drivo bearer token |
| `MCP_TRANSPORT` | | `http` (default) or `stdio` |
| `DRIVO_MCP_API_KEY` | stdio | The key to authenticate as in stdio mode |
| `PORT`, `HOST` | | default `3000`, `0.0.0.0` |
| `MCP_ALLOWED_HOSTS`, `MCP_ALLOWED_ORIGINS` | | comma lists; set in production |
| `DRIVO_API_TIMEOUT_MS` | | default 15000 |
| `DRIVO_MCP_RATE_LIMIT_PER_MINUTE`, `DRIVO_MCP_WRITE_RATE_LIMIT_PER_MINUTE` | | default 60 / 20 |
| `LOG_LEVEL` | | `debug|info|warn|error` |

## Run

```bash
npm run build && npm start      # remote mode on :3000   (GET /healthz, /readyz; POST /mcp)
npm run dev                     # tsx, no build
```

### Docker

```bash
docker build -t drivo-mcp .
docker run --rm -p 3000:3000 --env-file .env \
  -v $PWD/principals.json:/run/secrets/drivo-mcp-principals.json:ro drivo-mcp
```
The image runs as non-root, has a `HEALTHCHECK` on `/healthz`, and uses `tini` so `SIGTERM`
triggers graceful shutdown (readiness flips to 503, in-flight requests drain ≤10 s).

## Client configuration

**Claude Desktop / Claude Code (remote):**
```bash
claude mcp add --transport http drivo https://mcp.drivo.biz/mcp --header "Authorization: Bearer $DRIVO_MCP_KEY"
```

**Cursor** (`~/.cursor/mcp.json`):
```json
{ "mcpServers": { "drivo": { "url": "https://mcp.drivo.biz/mcp", "headers": { "Authorization": "Bearer ${env:DRIVO_MCP_KEY}" } } } }
```

**Local stdio:**
```json
{ "mcpServers": { "drivo": { "command": "node", "args": ["/path/to/drivo-mcp/dist/index.js"],
  "env": { "MCP_TRANSPORT": "stdio", "DRIVO_API_BASE_URL": "https://demo.drivo.biz",
           "DRIVO_MCP_PRINCIPALS_FILE": "/path/principals.json", "DRIVO_MCP_API_KEY": "…",
           "DRIVO_MCP_CONFIRM_SECRET": "…", "DRIVO_UPSTREAM_TOKEN_EXAMPLE_PRINCIPAL": "…" } } } }
```

## Development & testing

```bash
npm run typecheck
npm test            # unit + security + end-to-end over real HTTP with a fake Drivo upstream
```
Tests cover authentication, permission denial, company isolation, invalid inputs, read/write tools,
idempotency (incl. concurrency), API failure, timeouts, rate limiting, secret leakage and audit logging.

### MCP Inspector
```bash
npm run build
MCP_TRANSPORT=stdio DRIVO_MCP_API_KEY=… … npx @modelcontextprotocol/inspector node dist/index.js
# remote: npx @modelcontextprotocol/inspector  → Streamable HTTP → https://mcp.drivo.biz/mcp, header Authorization
```

## Registry publishing

`server.json` follows the current schema (`2025-12-11`) and registers `biz.drivo/drivo-erp`
(npm package `@dynaz/drivo-mcp` + the remote `https://mcp.drivo.biz/mcp`).

One-time: prove ownership of `drivo.biz` (the `biz.drivo` namespace) by DNS:
```bash
openssl genpkey -algorithm Ed25519 -out key.pem
openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64     # -> TXT: drivo.biz. "v=MCPv1; k=ed25519; p=<that>"
openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n'   # -> GitHub secret MCP_REGISTRY_DNS_PRIVATE_KEY
```
Release: bump versions in `package.json` + `server.json` (all must match), then `git tag vX.Y.Z && git push --tags`.
`publish-mcp.yml` runs tests → build → `npm publish` → `mcp-publisher login dns` → `validate` → `publish`.
Needs the `mcp-registry-publish` GitHub environment with `NPM_TOKEN` and `MCP_REGISTRY_DNS_PRIVATE_KEY`.

## Known limits (v0.1)

- Idempotency + rate-limit stores are in-memory (single replica). Interfaces are in `src/runtime/`.
- Drivo's POST routes have no server-side idempotency key (except the "open service job already exists"
  rule), so MCP-level idempotency protects against client retries, not against a lost MCP process restart.
- Hosting: `mcp.drivo.biz` DNS / reverse proxy are not part of this repo.

## License
MIT
