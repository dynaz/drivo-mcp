# Security Policy

## Reporting a vulnerability

Email **security@drivo.biz** (do not open a public issue). Include reproduction steps and the
affected version. We aim to acknowledge within 2 business days. Please do not test against
other dealers' data; use a demo tenant.

## Scope and design guarantees

Drivo MCP is a **gateway**, not a data store. It must never:

- connect to PostgreSQL or call raw Odoo RPC (`execute_kw`, SQL, shell) — only the Drivo API/service layer;
- expose a generic ORM/SQL/shell tool (the tool list is closed and tested);
- hold secrets in the repository (only `.env.example`, `principals.example.json`);
- return a record from a company the caller is not authorised for;
- run a write without an `idempotency_key`, or a high-risk write without a signed confirmation.

Anything that breaks one of these is a security bug.

## Operational guidance

- Principal registry (`principals.json`) stores **SHA-256 hashes** of API keys only. Generate keys with
  `npm run hash-key`; keep the file in a secret store, mode 0400.
- Give each principal a **dedicated least-privilege Drivo user**; its bearer token (referenced by
  `upstreamTokenEnv`) is the real RBAC boundary — Drivo enforces role and company scope server-side.
  MCP scopes only narrow further.
- Rotate keys by adding a new principal entry, switching clients, then deleting the old one.
- Terminate TLS at the reverse proxy; set `MCP_ALLOWED_HOSTS`/`MCP_ALLOWED_ORIGINS`.
- Run >1 replica only after replacing the in-memory rate-limit/idempotency stores with a shared one.
- Audit lines (`"audit": true`) are structured JSON on stderr; ship them to your log pipeline.
