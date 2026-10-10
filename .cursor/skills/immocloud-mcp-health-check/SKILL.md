---
name: immocloud-mcp-health-check
description: >-
  Runs a read-only Immocloud MCP connectivity and API-shape smoke test to detect
  auth failures or Immocloud private-API drift. Use when the user asks whether
  Immocloud MCP is working, healthy, broken, after Immocloud changes, or wants
  a compatibility / regression check.
---

# Immocloud MCP health check

Detect whether this MCP still talks to Immocloud correctly. Prefer the scripted
check; fall back to MCP tools if the script cannot run.

## Do not

- Run write tools (`confirm=true`, assign, book, update, delete).
- Print tokens, passwords, emails, IBANs, device IDs, or full profile payloads.
- Treat a single empty list as failure (empty portfolios are valid).

## Preferred: script

From the repo root (requires `.env` with working auth / session):

```bash
npm run health-check
```

Equivalent:

```bash
npm run build && node --env-file=.env dist/health-check.js
```

Exit codes: `0` all pass, `1` one or more checks failed, `2` oauth/status-only mode.

## Fallback: MCP tools (read-only)

If the script is unavailable, call in order and record pass/fail only:

1. `immocloud_auth_status` — expect `tokenPresent: true` (or guide login).
2. `immocloud_get_profile` — must return an object with `id` (do not echo PII).
3. `immocloud_list_properties` — must not 401/404/5xx.
4. `immocloud_list_bank_connections` — must not 401/404/5xx.
5. `immocloud_list_bank_transactions` — default UNASSIGNED page must not error.
6. `immocloud_list_finance_transactions` — must not error.

Stop early on auth failure and tell the user to fix login/session first.

## Report format

```markdown
## Immocloud MCP health

| Check | Result | Notes |
|---|---|---|
| auth | PASS/FAIL | … |
| profile | PASS/FAIL | shape ok / missing id |
| … | … | … |

**Verdict:** OK | BROKEN (likely Immocloud API drift) | AUTH ISSUE
```

If previously working endpoints suddenly 404 or return a new shape, say the
private API likely changed and point at `src/tools/` / `src/immocloud/client.ts`
for updates. Do not invent an Immocloud “API version” — Immocloud does not
expose one.
