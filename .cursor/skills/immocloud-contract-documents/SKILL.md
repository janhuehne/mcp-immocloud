---
name: immocloud-contract-documents
description: >-
  Uploads Immocloud rental-agreement documents (Mietvertrag, Mieterhöhung,
  Kaution receipt) into the tenancy CONTRACT slot via multipart POST /documents
  with correspondingTenancyId. Use when freigeben contracts, filling the rental
  agreements upload box, converting DOCX to PDF, or fixing empty CONTRACT UI.
---

# Immocloud contract documents

The tenancy **Mietverträge / rental agreements** slot is filled only when the
upload includes `correspondingTenancyId`. Unit/property alone leaves the UI empty.

There is no MCP upload tool yet — use an authenticated session (same as MCP:
`bootstrapAuthentication` + `FormData` POST to `{baseUrl}/documents`).

## Upload shape (UI-compatible)

```js
const form = new FormData();
form.append("files", new Blob([buf], { type: "application/pdf" }), filename);
form.append(
  "params",
  new Blob(
    [
      JSON.stringify({
        correspondingTenancyId: tenancyId, // required for CONTRACT slot
        documentCategory: "CONTRACT",
        // optional: assignedUnitIdList, assignedObjectIdList, transactionId
      }),
    ],
    { type: "application/json" },
  ),
);
await fetch(base + "/documents", { method: "POST", headers: authHeaders, body: form });
```

Auth headers: `Authorization: Bearer …`, `X-IMMOCLOUD-WHITELABEL`, optional
`X-Device-Id`. Do **not** set `Content-Type` manually (boundary must be set by fetch).

## Critical rules

1. **Always set `correspondingTenancyId`** on first upload for CONTRACT.
2. **PUT `/documents/{id}` cannot attach a tenancy** — if a file was uploaded
   unit-only, **re-upload** with tenancy id, then delete the orphan.
3. Prefer **PDF**. Convert DOCX with LibreOffice (Word/docx2pdf often fail headless):

```bash
mkdir -p /tmp/immocloud-docx2pdf/out
soffice --headless --convert-to pdf --outdir /tmp/immocloud-docx2pdf/out "/path/to/file.docx"
```

4. Upload **finals only**: signed/final Mieterhöhung PDFs. Skip drafts
   (`*_angepasst*`), Mahnungen, and unsigned future increases unless the user asks.
5. Modal display order is not reliably controllable via API — don’t spend cycles on it.
6. After upload, verify `GET /documents?correspondingTenancyId=…` or list by unit
   and confirm `documentCategory: CONTRACT` + tenancy id. Delete duplicates.

## Link receipt to a finance booking (Kaution)

Include `transactionId` in `params` (and optionally still `correspondingTenancyId` +
`documentCategory: CONTRACT`). Confirm with:

```
GET /documents?transactionId=<financeId>
```

`hasDocument` on the finance DTO may stay `false` even when the document list
shows the link — trust the documents query.

Update document metadata (name, unit, property, category, transactionId) via:

```
PUT /documents/{id}
{ name, assignedUnitIdList, assignedObjectIdList, documentCategory, costCategory, transactionId }
```

(`correspondingTenancyId` is not in the UI’s PUT allow-list.)

## Typical sources

Nextcloud: `…/Mieter/<folder>/Mietvertrag/` and `…/Kommunikation/`

| Keep | Skip (unless asked) |
|---|---|
| Original Mietvertrag PDF | Draft / watermarked DOCX only |
| Final Mieterhöhung PDF (converted if needed) | Mahnung, unsigned future increase |
| Kaution Einzahlungsbestätigung | Duplicates after re-upload |

## Related skills

- `immocloud-tenancy-onboarding` — create tenancy / tenantIdList first
- `immocloud-finance-safe-writes` — mark Kaution paid + attach confirmation
