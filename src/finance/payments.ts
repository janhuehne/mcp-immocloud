/**
 * Immocloud PUT /finance/transactions/{id} replaces the whole payments array.
 * Omitting payments (or sending []) silently unlinks the bank turnover.
 *
 * Partial PUTs also wipe identity (unit, contact, cost category, dates, rent
 * month/year). mergeIdentity copies those fields from the GET snapshot unless
 * the patch overrides them.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function paymentList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Fields Immocloud expects on finance PUTs; safe to round-trip from GET. */
export const FINANCE_PUT_IDENTITY_KEYS = [
  "allocable",
  "amount",
  "assignedContact",
  "assignedContactId",
  "assignedCostCategoryId",
  "assignedProperties",
  "assignedPropertyIdList",
  "assignedUnitIdList",
  "assignedUnits",
  "cashflowRelevant",
  "correspondingMonth",
  "correspondingTenancyId",
  "correspondingYear",
  "costCategory",
  "documentId",
  "dueDate",
  "ignoredInOperatingCostStatements",
  "markAsLost",
  "markAsPaid",
  "openAmount",
  "paymentState",
  "senderName",
  "startBalance",
  "subject",
  "transactionDate",
  "transactionType",
  "vat",
  "vatAmountInPercent",
] as const;

/** Clearing these on an existing rent makes Immocloud regenerate AUTO_RENT. */
export const FINANCE_PERIOD_KEYS = [
  "correspondingMonth",
  "correspondingYear",
  "transactionDate",
  "dueDate",
] as const;

export type FinancePutOptions = {
  clearPayments: boolean;
  transactionId: string;
  /**
   * When true (default), omit-safe identity fields are copied from `existing`
   * before applying the patch. Bank-assign / link flows use false so only the
   * explicit patch (+ payments) is sent.
   */
  mergeIdentity?: boolean;
  /**
   * When false (default), refuse patch values that clear period fields that
   * already had a value on the existing row.
   */
  clearPeriodFields?: boolean;
};

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isClearedPeriodValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function hasPeriodValue(value: unknown): boolean {
  return !isClearedPeriodValue(value);
}

export function looksLikeRentTransaction(
  value: Record<string, unknown>,
): boolean {
  if (isRecord(value.rentInfo)) {
    return true;
  }
  const source = value.source;
  if (
    typeof source === "string" &&
    (/AUTO_RENT/i.test(source) || /^RENT$/i.test(source.trim()))
  ) {
    return true;
  }
  const subject = value.subject;
  if (typeof subject === "string" && /^\s*Miete\b/i.test(subject)) {
    return true;
  }
  const costCategory = value.costCategory;
  if (isRecord(costCategory)) {
    const categoryType = costCategory.categoryType;
    if (
      typeof categoryType === "string" &&
      categoryType.toUpperCase() === "RENT_COST"
    ) {
      return true;
    }
    const name = costCategory.name ?? costCategory.label ?? costCategory.tag;
    if (typeof name === "string" && /^\s*Miete\b/i.test(name)) {
      return true;
    }
  }
  return false;
}

export function hasRentPeriod(value: Record<string, unknown>): boolean {
  return (
    hasPeriodValue(value.correspondingMonth) &&
    hasPeriodValue(value.correspondingYear)
  );
}

export function assertRentCreateHasPeriod(
  body: Record<string, unknown>,
): void {
  if (!looksLikeRentTransaction(body)) {
    return;
  }
  if (!hasRentPeriod(body)) {
    throw new Error(
      "Refusing to create a rent-like finance transaction without " +
        "correspondingMonth and correspondingYear. Assign the bank turnover " +
        "to an existing AUTO_RENT (immocloud_assign_bank_to_finance_transactions) " +
        "instead of creating a replacement Sollstellung.",
    );
  }
}

/**
 * Unit bookings without a cost category are the failure mode that created
 * period-less replacement Sollstellungen. Require an explicit rent period or
 * a non-rent cost category.
 */
export function assertUnitBookingHasPeriodOrCategory(allocation: {
  unitId?: string | undefined;
  costCategoryId?: string | undefined;
  correspondingMonth?: unknown;
  correspondingYear?: unknown;
}): void {
  if (!allocation.unitId || allocation.costCategoryId) {
    return;
  }
  if (
    hasPeriodValue(allocation.correspondingMonth) &&
    hasPeriodValue(allocation.correspondingYear)
  ) {
    return;
  }
  throw new Error(
    "Refusing unit booking without costCategoryId and correspondingMonth/Year. " +
      "For open Mietsollstellungen use immocloud_assign_bank_to_finance_transactions " +
      "against the existing AUTO_RENT — do not create a period-less replacement.",
  );
}

function pickIdentityFields(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of FINANCE_PUT_IDENTITY_KEYS) {
    if (hasOwn(existing, key) && existing[key] !== undefined) {
      picked[key] = existing[key];
    }
  }
  return picked;
}

function assertPeriodFieldsNotCleared(
  existing: Record<string, unknown>,
  body: Record<string, unknown>,
  patch: Record<string, unknown>,
  clearPeriodFields: boolean,
): void {
  if (clearPeriodFields) {
    return;
  }
  const cleared: string[] = [];
  for (const key of FINANCE_PERIOD_KEYS) {
    if (!hasOwn(patch, key)) {
      continue;
    }
    if (hasPeriodValue(existing[key]) && isClearedPeriodValue(patch[key])) {
      cleared.push(key);
    }
  }
  if (cleared.length === 0) {
    return;
  }
  // Restore so callers that merge still get a safe body if they catch/retry;
  // throw so the write does not proceed with a cleared period.
  for (const key of cleared) {
    body[key] = existing[key];
  }
  throw new Error(
    "Refusing finance update that clears rent/period fields " +
      `(${cleared.join(", ")}). Clearing date/month on a Sollstellung makes ` +
      "Immocloud regenerate AUTO_RENT overnight. Pass clearPeriodFields=true " +
      "only when intentionally detaching the period.",
  );
}

export function assertPeriodFieldsPreserved(
  before: Record<string, unknown>,
  after: unknown,
  options: { clearPeriodFields: boolean },
): void {
  if (options.clearPeriodFields || !looksLikeRentTransaction(before)) {
    return;
  }
  if (!isRecord(after)) {
    throw new Error(
      "Refusing result: finance update did not return a transaction object.",
    );
  }
  const lost: string[] = [];
  for (const key of FINANCE_PERIOD_KEYS) {
    if (hasPeriodValue(before[key]) && isClearedPeriodValue(after[key])) {
      lost.push(key);
    }
  }
  if (lost.length > 0) {
    throw new Error(
      "Refusing result: finance update dropped rent/period fields " +
        `(${lost.join(", ")}).`,
    );
  }
}

export function buildFinancePutBody(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  options: FinancePutOptions,
): Record<string, unknown> {
  if (!isRecord(existing)) {
    throw new Error("Existing finance transaction must be an object.");
  }
  if (!isRecord(patch)) {
    throw new Error("Finance update patch must be an object.");
  }

  const mergeIdentity = options.mergeIdentity !== false;
  const clearPeriodFields = options.clearPeriodFields === true;

  const body: Record<string, unknown> = mergeIdentity
    ? {
        ...pickIdentityFields(existing),
        ...patch,
        id: existing.id ?? options.transactionId,
      }
    : {
        ...patch,
        id: existing.id ?? options.transactionId,
      };

  // Drop undefined patch overlays so omitted keys keep identity values.
  if (mergeIdentity) {
    for (const key of Object.keys(body)) {
      if (body[key] === undefined && hasOwn(existing, key)) {
        body[key] = existing[key];
      }
    }
  }

  assertPeriodFieldsNotCleared(
    existing,
    body,
    patch,
    clearPeriodFields,
  );

  const existingPayments = paymentList(existing.payments);
  const patchHasPayments = hasOwn(patch, "payments");

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
