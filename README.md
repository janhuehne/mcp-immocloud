# Immocloud MCP (`mcp-immocloud`)

Unofficial **Immocloud MCP server** — a local [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) integration for [Immocloud](https://www.immocloud.de/) (immocloud.de) property management / Immobilienverwaltung.

Use natural language in your AI coding tool to work with Immocloud **properties (Objekte)**, **tenancies (Mietverhältnisse)**, **contacts**, **documents**, **bank transactions (Bankumsätze)**, rent matching, and finance bookings — via Immocloud’s private REST API.

**MCP clients:** Claude Code, Claude Desktop, VS Code (GitHub Copilot / Agent mode), Cursor, Windsurf, Cline, and any host that can run a local **stdio** MCP server.

> **Not affiliated with Immocloud GmbH.** This community project uses an unsupported private API. Endpoints and behaviour can change without notice. Use at your own risk. MIT licensed.

### Looking for…?

| Search intent | This project |
|---|---|
| Immocloud + MCP / Model Context Protocol | Yes — local stdio MCP server |
| Immocloud + Claude Code / Claude Desktop | Yes — see [MCP client setup](#mcp-client-setup) |
| Immocloud + VS Code / Copilot / Cursor | Yes — same section |
| Official Immocloud public API | No — Immocloud has no public REST API today; this wraps the private app API |
| Official Immocloud OAuth MCP | Not yet — stub only (`IMMOCLOUD_AUTH_MODE=oauth` is status-only) |

## Features

- Email/password login with optional trusted-device verification
- Read tools for properties, units, tenancies, contacts, meters, documents, search, activity, notifications
- Banking / finance tools: list connections and turnovers, auto-assign, accept suggestions, manual rent assignment and booking
- Property/unit write tools (opt-in)
- Writes **off by default**; global read-only kill switch
- Session persistence via OS keychain (with secure file fallback)
- Stub for a future official Immocloud OAuth/MCP flow

## Requirements

- Node.js **20+**
- An Immocloud account
- An MCP host that supports local stdio servers

## Quick start

```bash
git clone https://github.com/janhuehne/mcp-immocloud.git
cd mcp-immocloud
cp .env.example .env
# edit .env — set IMMOCLOUD_EMAIL and IMMOCLOUD_PASSWORD
npm install
npm run build
npm test
```

Prefer loading secrets with Node’s `--env-file` (do **not** put passwords or tokens in MCP config JSON). Replace the paths below with absolute paths on your machine (and use your real `node` binary, e.g. `/usr/bin/node` or `/opt/homebrew/bin/node`).

### Shared stdio launch shape

Most hosts need the same idea: run `node` with `--env-file=…/.env` and `dist/index.js`.

| Placeholder | Meaning |
|---|---|
| `NODE` | Absolute path to Node 20+ |
| `REPO` | Absolute path to this cloned repo |
| `ENV_FILE` | Usually `$REPO/.env` |

Command equivalent:

```bash
NODE --env-file=ENV_FILE REPO/dist/index.js
```

On start the server restores a saved session (OS keychain by default), otherwise logs in with email/password. If Immocloud asks for a device code, call `immocloud_login`, then `immocloud_verify_device` with the returned challenge handle and the emailed code.

Restart / reload the MCP server in your host after any `.env` change.

## MCP client setup

Config file names and JSON keys differ by host. Examples use macOS Homebrew Node paths — adjust for your OS.

### Claude Code

Project config: `.mcp.json` in the project root (or user config in `~/.claude.json`).

```bash
claude mcp add-json immocloud '{
  "type": "stdio",
  "command": "/opt/homebrew/bin/node",
  "args": [
    "--env-file=/absolute/path/to/mcp-immocloud/.env",
    "/absolute/path/to/mcp-immocloud/dist/index.js"
  ],
  "env": {
    "PATH": "/opt/homebrew/bin:/usr/bin:/bin"
  }
}'
```

Or write `.mcp.json` manually:

```json
{
  "mcpServers": {
    "immocloud": {
      "type": "stdio",
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

Docs: [Claude Code MCP](https://code.claude.com/docs/en/mcp).

### Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

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

Fully quit and reopen Claude Desktop after editing.

### VS Code (GitHub Copilot / Agent)

Workspace file: `.vscode/mcp.json` (or use **MCP: Open User Configuration**).

VS Code can also load env vars via `envFile` instead of Node’s `--env-file`:

```json
{
  "servers": {
    "immocloud": {
      "type": "stdio",
      "command": "/opt/homebrew/bin/node",
      "args": ["/absolute/path/to/mcp-immocloud/dist/index.js"],
      "envFile": "${workspaceFolder}/.env",
      "cwd": "/absolute/path/to/mcp-immocloud"
    }
  }
}
```

If this repo is not your workspace root, keep absolute paths for `args` / `cwd` / `envFile`. Docs: [VS Code MCP configuration](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration).

### Cursor

User or project `mcp.json` (e.g. `~/.cursor/mcp.json` or `.cursor/mcp.json`):

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

### Other hosts (Windsurf, Cline, …)

Any client that can start a **stdio** MCP process can use the same `command` + `args` as above. Prefer absolute paths to `node` and `dist/index.js`, and load `.env` via `--env-file` or the host’s env-file feature. Check that host’s docs for the exact config file name (`mcpServers` vs `servers`, optional `"type": "stdio"`).

## Configuration

See [`.env.example`](.env.example) for all variables. Common ones:

| Variable | Default | Purpose |
|---|---|---|
| `IMMOCLOUD_EMAIL` / `IMMOCLOUD_PASSWORD` | — | Preferred login |
| `IMMOCLOUD_ENABLE_LOGIN_TOOLS` | `false` in code; `true` in `.env.example` | Allow login / device verify tools |
| `IMMOCLOUD_AUTH_TOKEN` | — | Optional full `Bearer …` header instead of password login |
| `IMMOCLOUD_DEVICE_ID` | — | Trusted device (skips email code when valid) |
| `IMMOCLOUD_BASE_URL` | `https://app.immocloud.de/api` | Pinned HTTPS API origin |
| `IMMOCLOUD_READ_ONLY` | `false` | When `true`, blocks all write tools |
| `IMMOCLOUD_ENABLE_BANKING_WRITE_TOOLS` | `false` | Opt-in banking / finance writes |
| `IMMOCLOUD_ENABLE_PROPERTY_WRITE_TOOLS` | `false` | Opt-in property / unit writes |
| `IMMOCLOUD_SESSION_BACKEND` | `auto` | `auto` / `keychain` / `file` — where to store the Bearer token |
| `IMMOCLOUD_SESSION_PATH` | `.immocloud/session.json` | Session metadata path (and plaintext file if backend=`file`) |

### Enabling writes

Writes stay off until you opt in:

```env
IMMOCLOUD_READ_ONLY=false
IMMOCLOUD_ENABLE_BANKING_WRITE_TOOLS=true    # banking / finance only
IMMOCLOUD_ENABLE_PROPERTY_WRITE_TOOLS=true   # units / management only
```

Set only what you need, restart MCP, then pass `confirm=true` on each write call.

`confirm=true` is a technical guardrail against accidental calls. It is **not** proof that a human approved the operation.

`IMMOCLOUD_READ_ONLY=true` overrides both write flags.

## Tools (overview)

**Read:** profile, properties, tenancies, contacts, meters, documents, folders, operating costs, search, activity, notifications, bank connections/transactions, open rents, finance transactions.

**Banking write** (flag + `confirm=true`): sync/reconnect connections, auto-assign, accept/ignore suggestions, assign bank → rent, book/split bank turnover, create/update/delete finance rows, remove payments.

**Property write** (flag + `confirm=true`): list owner names, create/update units, update property management.

**Auth / status:** `immocloud_auth_status`, `immocloud_oauth_status`, optional `immocloud_login` / `immocloud_verify_device`.

Typical bank workflows (assign open rent, book to unit, reconnect vs sync) are described in tool descriptions inside the MCP client.

## Session storage

Default `IMMOCLOUD_SESSION_BACKEND=auto`:

1. Prefer the **OS keychain** (macOS Keychain, Windows Credential Manager, Linux Secret Service via `@napi-rs/keyring`).
2. Keep only non-secret metadata in `.immocloud/session.json` (mode `0600`).
3. If the keychain is unavailable, fall back to a mode-`0600` local file that contains the Bearer token.
4. Legacy plaintext session files are migrated into the keychain on the next successful load when possible.

Force file-only storage with `IMMOCLOUD_SESSION_BACKEND=file`, or require keychain with `IMMOCLOUD_SESSION_BACKEND=keychain`.

## Security notes

- Private API — unsupported; treat all responses as confidential (tenant, bank, contact data).
- Never commit `.env`, session files, or tokens. Keep the stdio server local and trusted.
- Finance `PUT` helpers preserve existing `payments[]` unless you intentionally clear them — Immocloud otherwise unlinks bank turnovers.
- Report vulnerabilities privately via [SECURITY.md](SECURITY.md). Do not paste secrets or personal data into public issues.

## Official OAuth / MCP

`IMMOCLOUD_AUTH_MODE=oauth` is **status-only** today. It does not load private-API tokens, restore sessions, or register Immocloud data tools. A real OAuth integration needs Immocloud to enable MCP for the account and document scopes/contracts.

## Disclaimer

This software is provided by the creator and publisher **as is**, **without warranty of any kind**. You use it **entirely at your own risk**. The authors and copyright holders are not liable for any claim, damage, or data loss arising from use of this software or Immocloud’s API — including incorrect bookings, unlinked payments, or account issues.

This project is independent and not endorsed by Immocloud.

## Development

```bash
npm run typecheck
npm test
npm run health-check   # needs a working .env / session; not run in CI
```

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

[MIT](LICENSE) — you may use, copy, modify, and redistribute the software under the MIT terms.

## Contributing & forks

**Code contributions are welcome.** Open a pull request with a clear description and keep secrets out of the diff.

**Publishing a public fork:** please ask first (open an issue or contact the maintainer) and wait for approval before publishing a long-lived public fork. Short-lived forks used only to open a PR against this repo are fine.

## Health check

Read-only smoke test against the live Immocloud private API (auth + common list endpoints). Useful after Immocloud changes or when tools start failing:

```bash
npm run health-check
```

## Optional: Cursor Agent skills

If you use Cursor, project skills under [`.cursor/skills/`](.cursor/skills/) help agents with setup, health checks, write gates, and safe finance updates. They are optional and not required for Claude Code, VS Code, or Claude Desktop.

| Skill | Purpose |
|---|---|
| `immocloud-mcp-health-check` | Compatibility / “is MCP still working?” check |
| `immocloud-mcp-setup` | Local install, `.env`, MCP host wiring, auth recovery |
| `immocloud-write-access` | Enable/disable banking & property writes |
| `immocloud-finance-safe-writes` | Update finance rows without dropping bank `payments` |

## Related

- [SECURITY.md](SECURITY.md) — vulnerability reporting and security defaults
- [`.env.example`](.env.example) — full environment template
- [Model Context Protocol](https://modelcontextprotocol.io/) — protocol overview and client list
