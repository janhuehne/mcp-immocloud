/**
 * Tenancy Abrechnungsdaten helpers (Personenanzahl).
 * Prefer typed patches over raw full-body tenancy PUTs.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type NumberOfTenantsEntry = {
  startDate: string;
  numberOfTenants: number;
};

const TENANCY_PUT_STRIP_KEYS = new Set([
  "createdDate",
  "lastModifiedDate",
  "vatRateStatus",
  "currentVatRate",
  "lastRentChangeDate",
  "totalRentAmount",
  "totalRentAmountIncludingVat",
  "coldRent",
  "currentRent",
  "commercialRent",
  "formerSubUnit",
  "noIntermediateReadingAvailable",
  "currentNumberOfTenants",
  "totalRentPresent",
  "tenantNamesString",
  "tenantDebtorIdsString",
  "coldRentIncludingVat",
  "additionalCosts",
  "additionalCostsIncludingVat",
  "heatingCosts",
  "heatingCostsIncludingVat",
  "otherCosts",
  "otherCostsIncludingVat",
  "otherCostsIndexRelevant",
  "upfrontPaymentCosts",
  "upfrontPaymentCostsIncludingVat",
  "prepaidCosts",
  "prepaidCostsIncludingVat",
  "subunitCosts",
]);

export function buildTenancyPersonsPutBody(
  existing: Record<string, unknown>,
  numberOfTenants: NumberOfTenantsEntry[],
): Record<string, unknown> {
  if (!isRecord(existing)) {
    throw new Error("Existing tenancy must be an object.");
  }
  if (numberOfTenants.length === 0) {
    throw new Error("numberOfTenants must contain at least one entry.");
  }
  for (const entry of numberOfTenants) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.startDate)) {
      throw new Error(
        `Invalid startDate "${entry.startDate}" (expected YYYY-MM-DD).`,
      );
    }
    if (
      !Number.isInteger(entry.numberOfTenants) ||
      entry.numberOfTenants < 0
    ) {
      throw new Error(
        `numberOfTenants must be an integer >= 0 (got ${entry.numberOfTenants}).`,
      );
    }
  }

  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (TENANCY_PUT_STRIP_KEYS.has(key)) {
      continue;
    }
    body[key] = value;
  }

  body.numberOfTenants = numberOfTenants.map((entry) => ({
    startDate: entry.startDate,
    numberOfTenants: entry.numberOfTenants,
  }));

  // Immocloud UI always sends tenantIdList with tenantList.
  if (
    (!Array.isArray(body.tenantIdList) || body.tenantIdList.length === 0) &&
    Array.isArray(body.tenantList)
  ) {
    const ids = body.tenantList
      .map((tenant) => {
        if (isRecord(tenant) && typeof tenant.id === "string") {
          return tenant.id;
        }
        return undefined;
      })
      .filter((id): id is string => id !== undefined);
    if (ids.length > 0) {
      body.tenantIdList = ids;
    }
  }

  // Slim tenantList to ids — full contact blobs are read-model noise.
  if (Array.isArray(body.tenantList)) {
    body.tenantList = body.tenantList
      .map((tenant) => {
        if (isRecord(tenant) && typeof tenant.id === "string") {
          return { id: tenant.id };
        }
        return tenant;
      })
      .filter(Boolean);
  }

  return body;
}

export function tenancyPersonsSnapshot(
  tenancy: Record<string, unknown>,
): NumberOfTenantsEntry[] {
  const list = Array.isArray(tenancy.numberOfTenants)
    ? tenancy.numberOfTenants
    : [];
  return list
    .filter(isRecord)
    .map((entry) => ({
      startDate: String(entry.startDate ?? ""),
      numberOfTenants:
        typeof entry.numberOfTenants === "number" ? entry.numberOfTenants : -1,
    }));
}

export function assertTenancyPersonsApplied(
  tenancyAfter: Record<string, unknown>,
  expected: NumberOfTenantsEntry[],
): NumberOfTenantsEntry[] {
  const got = tenancyPersonsSnapshot(tenancyAfter);
  if (got.length !== expected.length) {
    throw new Error(
      `Personenanzahl not persisted: expected ${expected.length} entries, got ${got.length}.`,
    );
  }
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i]!;
    const actual = got[i]!;
    if (
      actual.startDate !== want.startDate ||
      actual.numberOfTenants !== want.numberOfTenants
    ) {
      throw new Error(
        `Personenanzahl not persisted at index ${i}: expected ${want.startDate}/${want.numberOfTenants}, got ${actual.startDate}/${actual.numberOfTenants}.`,
      );
    }
  }
  return got;
}
