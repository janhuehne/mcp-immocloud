# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.8] - 2026-10-12

### Fixed

- `immocloud_update_finance_transaction` merges identity fields from GET (unit, contact, category, dates, `correspondingMonth` / `correspondingYear`) so partial patches no longer wipe Mietsollstellung period keys
- Refuses clearing rent/period fields unless `clearPeriodFields=true` (prevents overnight `AUTO_RENT` duplicates)
- `immocloud_create_finance_transaction` / `immocloud_create_manual_finance_transaction` require `correspondingMonth` + `correspondingYear` on rent-like bodies and re-check the created row
- `immocloud_book_bank_transaction` refuses unit bookings without `costCategoryId` unless `correspondingMonth` + `correspondingYear` are set (blocks period-less replacement Sollstellungen)

### Changed

- Bank-assign / book link PUTs keep minimal bodies (`mergeIdentity: false`); update path uses identity merge
- Identity merge omits server-derived fields (`hasDocument`, `rentInfo`, `objectInfo`)
- Finance safe-write skill and payments rule document the AUTO_RENT duplicate failure mode

## [1.0.7] - 2026-10-12

### Changed

- `immocloud_calculate_operating_cost` defaults to `refreshUnitMasterData=true`: re-PUTs `unitIds` before `/calculate` so MEA/Wohnfläche reload from property master data (bare calculate kept stale snapshots). Returns before/after unit MEA diffs.

## [1.0.6] - 2026-10-12

### Added

- `immocloud_download_operating_cost_pdf` — download one BKA export (`pdf` / `docx` / `xlsx` / `zip` per tenancy, or `all=true` for the Sammel-ZIP) via `/operatingcost/{id}/pdf/{tenancyId}` and `/pdf/all`
- `immocloud_download_operating_cost_pdfs` — download every tenancy PDF for a statement (plus optional Sammel-ZIP) into `./downloads/`
- `ImmocloudClient.getBinary` for authenticated binary downloads (PDF/ZIP/…)

### Changed

- Authenticated API requests send `X-Device-Id` when a trusted device id is present

## [1.0.5] - 2026-10-11

### Added

- `immocloud_list_account_charts` / `immocloud_list_cost_categories` — Kontenrahmen and cost-category listing with type/query/custom filters
- `immocloud_create_cost_category` / `immocloud_update_cost_category` / `immocloud_delete_cost_category` — custom categories via `/account-charts/{id}/cost-categories` (banking write flag + `confirm=true`; keyed by `technicalId`)
- Nebenkosten/BKA tools: `immocloud_list_operating_costs`, `immocloud_get_operating_cost`, `immocloud_validate_operating_cost_property` (read); create/update/add/update/delete cost entries, calculate, delete statement (banking write flag + `confirm=true`; v2 `/operating-cost-v2` + legacy `/operatingcost`)
- `immocloud_create_operating_cost` auto-injects Jackson `className: CreateOperatingCostStatementDto` (missing discriminator was Immocloud error 7003)


## [1.0.4] - 2026-10-10

### Added

- `immocloud_update_rent_bank_account` — typed Mieteingangskonto (Kontoinhaber / IBAN / BIC) for property and/or units (UI: Abrechnungsdaten → Bankkonto)
- `immocloud_update_unit_accounting` — typed Abrechnungsdaten (MEA / Wohnfläche) via `PUT /properties/{id}` with before/after verification (Immocloud UI path; unit PUT does not persist `ownershipShareValue`)
- `immocloud_update_tenancy_persons` — typed Personenanzahl updates with GET→merge→PUT and verification

### Changed

- `immocloud_update_unit` merges from GET (partial patches), refuses Abrechnungsdaten fields (redirects to accounting tool), returns a compact unit summary instead of the full property dump

## [1.0.2] - 2026-10-10

### Changed

- README and package metadata improved for discoverability (Immocloud MCP / Claude / VS Code / Cursor search intents, German property-management terms)

## [1.0.1] - 2026-10-10

### Changed

- README documents MCP setup for Claude Code, Claude Desktop, VS Code, Cursor, and other stdio hosts (not Cursor-only)
- Setup skill wording aligned with multi-client usage

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

[1.0.8]: https://github.com/janhuehne/mcp-immocloud/releases/tag/v1.0.8
[1.0.7]: https://github.com/janhuehne/mcp-immocloud/releases/tag/v1.0.7
[1.0.6]: https://github.com/janhuehne/mcp-immocloud/releases/tag/v1.0.6
[1.0.5]: https://github.com/janhuehne/mcp-immocloud/releases/tag/v1.0.5
[1.0.4]: https://github.com/janhuehne/mcp-immocloud/releases/tag/v1.0.4
[1.0.2]: https://github.com/janhuehne/mcp-immocloud/releases/tag/v1.0.2
[1.0.1]: https://github.com/janhuehne/mcp-immocloud/releases/tag/v1.0.1
[1.0.0]: https://github.com/janhuehne/mcp-immocloud/releases/tag/v1.0.0
