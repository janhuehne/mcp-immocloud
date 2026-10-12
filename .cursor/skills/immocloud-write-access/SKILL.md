---
name: immocloud-write-access
description: >-
  Explains and applies Immocloud MCP write-tool gates (banking, property,
  READ_ONLY, confirm). Use when enabling or disabling writes, mutating finance
  or units, or when write tools are missing/refused.
---

# Immocloud write access

Writes are **off by default**. `confirm=true` is only a technical guardrail — not
human approval.

## Enable (restart MCP after edits)

Banking / finance only:

```env
IMMOCLOUD_READ_ONLY=false
IMMOCLOUD_ENABLE_BANKING_WRITE_TOOLS=true
```

Property / units only:

```env
IMMOCLOUD_READ_ONLY=false
IMMOCLOUD_ENABLE_PROPERTY_WRITE_TOOLS=true
```

## Disable / panic switch

```env
IMMOCLOUD_READ_ONLY=true
```

or set both enable flags to `false`.

## Agent rules

1. Do not enable write flags unless the user clearly asks for mutation.
2. Prefer the smallest flag surface (banking XOR property when possible).
3. Every write tool call still needs `confirm=true`.
4. After enabling, remind the user to restart the MCP server.
5. For finance PUTs, follow `immocloud-finance-safe-writes`.
6. For Freigabe (unit/tenancy/contact), follow `immocloud-tenancy-onboarding`.
7. For Mietvertrag / CONTRACT uploads, follow `immocloud-contract-documents`.
8. For Abrechnungsdaten (MEA / Wohnfläche) use `immocloud_update_unit_accounting`, not raw `immocloud_update_unit`. For Personenanzahl use `immocloud_update_tenancy_persons`.
9. Custom Kontenrahmen categories (e.g. Umbuchung Rücklage) use `immocloud_create_cost_category` (banking write flag); book with `costCategory.technicalId` via `immocloud_update_finance_transaction`.
