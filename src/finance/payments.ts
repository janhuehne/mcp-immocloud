/**
 * Immocloud PUT /finance/transactions/{id} replaces the whole payments array.
 * Omitting payments (or sending []) silently unlinks the bank turnover.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function paymentList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function buildFinancePutBody(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  options: { clearPayments: boolean; transactionId: string },
): Record<string, unknown> {
  if (!isRecord(existing)) {
    throw new Error("Existing finance transaction must be an object.");
  }

  const body: Record<string, unknown> = {
    ...patch,
    id: existing.id ?? options.transactionId,
  };

  const existingPayments = paymentList(existing.payments);
  const patchHasPayments = Object.prototype.hasOwnProperty.call(
    patch,
    "payments",
  );

  if (options.clearPayments) {
    body.payments = [];
    return body;
  }

  if (!patchHasPayments || patch.payments === undefined) {
    body.payments = existingPayments;
    return body;
  }

  if (!Array.isArray(patch.payments)) {
    throw new Error("Finance payments must be an array.");
  }
  const nextPayments = paymentList(patch.payments);
  if (nextPayments.length === 0 && existingPayments.length > 0) {
    // Accidental wipe guard — use clearPayments=true to unlink deliberately.
    body.payments = existingPayments;
  }

  return body;
}
