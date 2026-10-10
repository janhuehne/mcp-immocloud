# Immocloud MCP

Unofficial [Model Context Protocol](https://modelcontextprotocol.io/) server for [Immocloud](https://www.immocloud.de/) property management.

Talk to your Immocloud account from Cursor (or any MCP client): properties, tenancies, contacts, documents, bank transactions, rent matching, and more — via Immocloud’s private REST API.

> **Not affiliated with Immocloud.** This project uses an unsupported private API. Endpoints and behaviour can change without notice. Use at your own risk.

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
- An MCP client (e.g. Cursor)

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

Point Cursor at the built server. Prefer loading secrets via Node’s `--env-file` (do **not** put passwords or tokens in `mcp.json`):

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

On start the server restores a saved session (OS keychain by default), otherwise logs in with email/password. If Immocloud asks for a device code, call `immocloud_login`, then `immocloud_verify_device` with the returned challenge handle and the emailed code.

Restart the MCP server after any `.env` change.

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

## Cursor skills

Project skills live under [`.cursor/skills/`](.cursor/skills/):

| Skill | Purpose |
|---|---|
| `immocloud-mcp-health-check` | Compatibility / “is MCP still working?” check |
| `immocloud-mcp-setup` | Local install, `.env`, Cursor `mcp.json`, auth recovery |
| `immocloud-write-access` | Enable/disable banking & property writes |
| `immocloud-finance-safe-writes` | Update finance rows without dropping bank `payments` |

## Related

- [SECURITY.md](SECURITY.md) — vulnerability reporting and security defaults
- [`.env.example`](.env.example) — full environment template
