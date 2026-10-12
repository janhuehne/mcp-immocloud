---
name: immocloud-tenancy-onboarding
description: >-
  Onboards Immocloud units and tenancies from Nextcloud Mieter folders (Freigabe):
  create unit, contact, tenancy with tenantIdList, rent schedules, deposit, and
  fix Sammelkunde on rents. Use when freigeben, importing a Mietverhältnis,
  creating units/tenancies/contacts, or tenant link looks empty in the UI.
---

# Immocloud tenancy onboarding (Freigabe)

End-to-end property write flow for a new or historical tenancy (e.g. RS810 App.122
Beyer, GUS20 Pagano). Requires property write tools — see `immocloud-write-access`.

## Prerequisites

1. `IMMOCLOUD_ENABLE_PROPERTY_WRITE_TOOLS=true`, `IMMOCLOUD_READ_ONLY=false`, MCP restarted
2. Banking writes only if also settling Kaution / bank assign → `immocloud-finance-safe-writes`
3. Source folder typically: Nextcloud `…/Einheiten/<unit>/Mieter/<start> <Name>/`

## Checklist

```
- [ ] Unit exists (or create via immocloud_create_unit)
- [ ] Contact created / found (immocloud_create_contact / list_contacts)
- [ ] Tenancy created with tenantIdList + rents[] + deposit
- [ ] Verify GET: tenantList / tenantIdList non-empty
- [ ] Rent finance rows use tenant contact, not Sammelkunde
- [ ] CONTRACT docs → immocloud-contract-documents
- [ ] Deposit settled → immocloud-finance-safe-writes (Kaution)
```

## tenantIdList (hard requirement)

Immocloud’s UI always sends `tenantIdList` with `tenantList`.

| Mistake | Result |
|---|---|
| Only `tenantList: [{ id }]` | Create: empty tenants; update: often HTTP 500 |
| `tenantIdList: [contactId]` (+ optional tenantList) | Works |

MCP `immocloud_create_tenancy` / `immocloud_update_tenancy` derive `tenantIdList` from
`tenantList[].id` when missing — still prefer sending both explicitly:

```json
{
  "tenantIdList": ["<contactId>"],
  "tenantList": [{ "id": "<contactId>" }],
  "contractStart": "YYYY-MM-DD",
  "contractType": "PERMANENT",
  "rentInterval": "MONTHLY",
  "rents": [{ "startDate": "…", "coldRent": 0, "additionalCosts": 0, "heatingCosts": 0 }],
  "deposit": { "amount": 550, "type": "TRANSFER", "dueDate": "YYYY-MM-DD" }
}
```

## Tools (preferred order)

1. `immocloud_list_properties` / `immocloud_get_property` — resolve property + unit IDs
2. `immocloud_create_unit` — clone shape from a sibling unit when possible; strip ids
3. `immocloud_create_contact` — PERSON + companyType TENANT; link property/unit if supported
4. `immocloud_create_tenancy` with `confirm=true` on `unitId`
5. `immocloud_list_property_tenancies` / `immocloud_get_contact` — verify link
6. Optional: `immocloud_mark_unit_rents_paid` for historical “already paid” rents (no bank)

## Sammelkunde on rents

AUTO-generated rent finance rows often land on **Sammelkunde/Sammellieferant**.
After tenancy + tenant exist:

1. `immocloud_list_finance_transactions` for the unit / tenancy
2. For each rent with wrong `assignedContactId`, `immocloud_update_finance_transaction`
   with full identity fields kept (see finance skill) and
   `assignedContactId` / `assignedContact` / `senderName` = tenant
3. Never wipe `payments[]`

## UI “lost tenant”

If API shows `tenantIdList` correctly but the UI looks empty → client cache.
Ask the user to hard-reload; do not re-PUT blindly.

## Abrechnungsdaten

UI tab **Abrechnungsdaten → Bankkonto** is the Mieteingangskonto (not MEA).

| Field | Tool |
|---|---|
| Kontoinhaber / IBAN / BIC | `immocloud_update_rent_bank_account` |
| Miteigentumsanteil, Wohnfläche | `immocloud_update_unit_accounting` (property PUT + verify) |
| Personenanzahl | `immocloud_update_tenancy_persons` (0 for TG/Garage) |

Do **not** set `ownershipShareValue` via `immocloud_update_unit` — Immocloud ignores MEA on unit PUT.

```json
{
  "confirm": true,
  "propertyId": "<propertyId>",
  "units": [
    { "unitId": "<appUnitId>", "ownershipShareValue": 41.985, "livingSpace": 19.82 }
  ]
}
```

TG Stellplätze that share the Wohnungseigentum Blatt usually keep MEA `0` on the parking unit (MEA stays on the App).

## Related skills

- `immocloud-contract-documents` — Mietvertrag / Mieterhöhung into CONTRACT slot
- `immocloud-finance-safe-writes` — Kaution, bank assign, markAsPaid
- `immocloud-write-access` — enable flags
