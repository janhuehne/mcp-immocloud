---
name: immocloud-finance-safe-writes
description: >-
  Safely updates Immocloud finance bookings without unlinking bank payments.
  Use when assigning rents, booking bank turnovers, editing finance
  transactions, categories, VAT, contacts, or documents on paid items.
---

# Immocloud finance safe writes

Immocloud `PUT /finance/transactions/{id}` **replaces** `payments`. Omitting
`payments` or sending `[]` unlinks the bank turnover; the booking can stay
`PAID` while the bank tx becomes `UNASSIGNED`.

## Required flow

1. Confirm banking writes are enabled (`IMMOCLOUD_ENABLE_BANKING_WRITE_TOOLS`).
2. Prefer MCP helpers that already preserve payments:
   - `immocloud_update_finance_transaction` (default preserves)
   - `immocloud_assign_bank_to_finance_transactions`
   - `immocloud_book_bank_transaction`
3. Never craft a raw payments-less PUT for “just” category/VAT/contact/document.
4. After any update: verify `payments.length > 0` and bank state **ASSIGNED**
   when a link was expected — not only finance status `PAID`.
5. Unlink only when the user asks:
   - `immocloud_remove_bank_transaction_payments`, or
   - `immocloud_update_finance_transaction` with `clearPayments=true`

## Manual assign pattern

1. `immocloud_list_bank_transactions` → pick bank tx
2. `immocloud_list_finance_transactions` (e.g. open RENT) → pick targets
3. `immocloud_assign_bank_to_finance_transactions` with `confirm=true`
