---
name: immocloud-mcp-setup
description: >-
  Sets up or repairs local Immocloud MCP configuration for Cursor (.env,
  build, mcp.json, login/session). Use when installing Immocloud MCP, wiring
  Cursor, fixing auth bootstrap, or onboarding a new machine.
---

# Immocloud MCP setup

## Checklist

1. Node.js 20+
2. `cp .env.example .env` and set `IMMOCLOUD_EMAIL` / `IMMOCLOUD_PASSWORD`
3. Keep write flags `false` unless the user wants mutation
4. `npm install && npm run build`
5. Cursor `mcp.json` must use `node --env-file=…/.env` + `dist/index.js`
6. Never put password or Bearer token inside `mcp.json`
7. Restart MCP after `.env` changes
8. Verify with `npm run health-check` or the health-check skill

## Cursor snippet

Use absolute paths:

```json
{
  "mcpServers": {
    "immocloud": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "--env-file=/absolute/path/to/immocloud-mcp/.env",
        "/absolute/path/to/immocloud-mcp/dist/index.js"
      ],
      "env": {
        "PATH": "/opt/homebrew/bin:/usr/bin:/bin"
      }
    }
  }
}
```

## Auth recovery

| Symptom | Action |
|---|---|
| No token / unauthenticated | Enable `IMMOCLOUD_ENABLE_LOGIN_TOOLS=true`, set email/password, restart |
| Device code required | `immocloud_login` → `immocloud_verify_device` with challenge handle + code |
| 401 after it worked | Delete `.immocloud/session.json`, re-login |
| OAuth mode | Status-only; switch to `IMMOCLOUD_AUTH_MODE=token` for real tools |

Sessions default to the OS keychain (`IMMOCLOUD_SESSION_BACKEND=auto`).
`.immocloud/session.json` holds metadata (and a plaintext token only on file
fallback). Treat any file that contains a Bearer token as secret.
