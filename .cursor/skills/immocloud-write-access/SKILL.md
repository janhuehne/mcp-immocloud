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
5. For finance PUTs, follow the finance-safe-writes skill / payments rule.
