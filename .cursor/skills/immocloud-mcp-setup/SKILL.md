---
name: immocloud-mcp-setup
description: >-
  Sets up or repairs local Immocloud MCP configuration for any MCP host (.env,
  build, stdio mcp.json / Claude Code / VS Code / Claude Desktop, login/session).
  Use when installing Immocloud MCP, wiring a client, fixing auth bootstrap, or
  onboarding a new machine.
---

# Immocloud MCP setup

## Checklist

1. Node.js 20+
2. `cp .env.example .env` and set `IMMOCLOUD_EMAIL` / `IMMOCLOUD_PASSWORD`
3. Keep write flags `false` unless the user wants mutation
4. `npm install && npm run build`
5. Host MCP config must launch `node --env-file=…/.env` + `dist/index.js` (or equivalent `envFile`)
6. Never put password or Bearer token inside MCP JSON config
7. Restart / reload MCP in the host after `.env` changes
8. Verify with `npm run health-check` or the health-check skill

## Stdio snippet (Claude Code / Cursor / Claude Desktop style)

Use absolute paths. See README for VS Code’s `.vscode/mcp.json` (`servers` + `envFile`) variant.

```json
{
  "mcpServers": {
    "immocloud": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "--env-file=/absolute/path/to/mcp-immocloud/.env",
        "/absolute/path/to/mcp-immocloud/dist/index.js"
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
