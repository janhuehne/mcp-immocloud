---
name: immocloud-finance-safe-writes
description: >-
  Safely updates Immocloud finance bookings without unlinking bank payments or
  wiping assignment fields. Use when assigning rents, Kaution/deposits, booking
  bank turnovers, markAsPaid, editing category/VAT/contact/document on paid items.
---

# Immocloud finance safe writes

Immocloud `PUT /finance/transactions/{id}` **replaces** `payments`. Omitting
`payments` or sending `[]` unlinks the bank turnover; the booking can stay
`PAID` while the bank tx becomes `UNASSIGNED`.

A **partial** body (only `markAsPaid` / `paymentState`) also wipes identity
at the API: unit, contact → Sammelkunde, cost category → Sonstiges, dates,
tenancy, **correspondingMonth/Year**. Clearing the rent period makes Immocloud
regenerate `AUTO_RENT` overnight (duplicate Sollstellung).

`immocloud_update_finance_transaction` therefore **merges identity** from GET
and **refuses clearing period fields** unless `clearPeriodFields=true`.

## Required flow

1. Confirm banking writes (`IMMOCLOUD_ENABLE_BANKING_WRITE_TOOLS`); see write-access.
2. Prefer MCP helpers that preserve payments **and** identity:
   - `immocloud_update_finance_transaction` (merges identity; preserves `payments[]`)
   - `immocloud_assign_bank_to_finance_transactions` for open rents
   - `immocloud_book_bank_transaction` only for non-rent splits (Hausgeld, etc.)
3. Never create a replacement Mietsollstellung without `correspondingMonth` +
   `correspondingYear`. Prefer assign to the existing `AUTO_RENT`.
4. Never craft a raw payments-less PUT for “just” category/VAT/contact/document.
5. After any update that should keep a bank link: verify `payments.length > 0`
   and bank state **ASSIGNED** — not only finance `PAID`.
6. Unlink only when the user asks:
   - `immocloud_remove_bank_transaction_payments`, or
   - `immocloud_update_finance_transaction` with `clearPayments=true`
7. Detach rent period only with `clearPeriodFields=true` (rare; support cases).
8. Category-only fixes: GET → PUT with full identity + `costCategory` (object or
   `technicalId` from `immocloud_list_cost_categories`) + preserved `payments[]`.
   Custom labels (e.g. Umbuchung Rücklage) are created via
   `immocloud_create_cost_category` first.

## Manual bank assign (GUS20 / Pagano style)

When a matching bank turnover exists:

1. `immocloud_list_bank_transactions` → pick bank tx
2. `immocloud_list_finance_transactions` (open RENT / Kaution) → pick targets
3. `immocloud_assign_bank_to_finance_transactions` with `confirm=true`
4. Verify finance `payments[]` and bank **ASSIGNED**

## Kaution / AUTO_DEPOSIT without bank history

Historical deposits (e.g. 2020) often have **no** bank row (history starts later).

1. `immocloud_get_finance_transaction` on the AUTO_DEPOSIT row
2. Prefer bank assign if a turnover matches amount/date/contact
3. Else mark paid (same outcome as “als bezahlt markieren”):

```json
{
  "confirm": true,
  "transactionId": "<depositId>",
  "clearPayments": false,
  "body": {
    "amount": 550,
    "markAsPaid": true,
    "paymentState": "PAID",
    "openAmount": 0,
    "transactionDate": "YYYY-MM-DD",
    "dueDate": "YYYY-MM-DD",
    "subject": "Kaution",
    "transactionType": "INCOME",
    "costCategory": { "...": "keep Kaution / technicalId 10 from GET" },
    "assignedUnits": ["...from GET..."],
    "assignedContactId": "<tenantId>",
    "assignedContact": { "...from GET..." },
    "senderName": "<tenant name>",
    "correspondingTenancyId": "<tenancyId>",
    "correspondingYear": 2020,
    "correspondingMonth": 2
  }
}
```

4. Upload Einzahlungsbestätigung with `transactionId` (+ CONTRACT tenancy) —
   see `immocloud-contract-documents`
5. Verify: `paymentState=PAID`, `openAmount=0`, contact/unit/category intact;
   unit not in `immocloud_list_open_rent_positions`

**422 `amount` darf nicht null sein** → include `amount` from GET.
**Partial PUT wiped unit/contact** → restore full GET snapshot + paid flags.

## Contact fix (Sammelkunde → tenant)

Same as update above: GET each rent/deposit, PUT with tenant
`assignedContactId` / `assignedContact` / `senderName`, preserve `payments[]`
and all other identity fields. Batch carefully; verify a sample after.

## Related skills

- `immocloud-tenancy-onboarding` — create tenancy before deposit exists
- `immocloud-contract-documents` — attach Kaution PDF / CONTRACT
- `immocloud-write-access` — enable banking writes
