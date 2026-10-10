# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-10

First public release of the unofficial Immocloud MCP server.

### Added

- Read tools for profile, properties, tenancies, contacts, meters, documents, search, activity, and notifications
- Banking / finance tools (list, assign, book, suggestions, bank connection sync/reconnect)
- Property / unit write tools (opt-in)
- Email/password login with trusted-device verification and local session persistence
- Write gates: banking and property writes off by default, `IMMOCLOUD_READ_ONLY`, `confirm=true`
- Finance PUT helper that preserves `payments[]` unless intentionally cleared
- ID path-safety checks (numeric, 24-char ObjectId, UUID), HTTPS API pin, response redaction
- `npm run health-check` smoke test against the live private API
- Cursor project skills for setup, health check, write access, and safe finance writes
- Unit tests (config, IDs, redaction, finance payments) and GitHub Actions CI

### Fixed

- Immocloud 24-character hex ObjectIds are accepted in path IDs (not only numeric/UUID)

### Security

- Sessions prefer the OS keychain (`IMMOCLOUD_SESSION_BACKEND=auto`) via `@napi-rs/keyring`, with mode-`0600` metadata under `.immocloud/`; file fallback when keychain is unavailable; automatic migration from legacy plaintext session files
- OAuth mode is status-only and does not restore private-API sessions

[1.0.0]: https://github.com/janhuehne/mcp-immocloud/releases/tag/v1.0.0
