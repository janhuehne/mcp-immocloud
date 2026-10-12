/**
 * Immocloud Abrechnungsdaten (MEA / Wohnfläche) are saved like the UI:
 * PUT /properties/{id} with the full property and patched units[].
 * PUT /properties/{id}/units/{unitId} accepts ownershipShareValue but does not persist it.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type UnitAccountingPatch = {
  unitId: string;
  ownershipShareValue?: number;
  livingSpace?: number;
  usableFloorSpace?: number;
  additionalHeatingArea?: number;
};

export type UnitAccountingSnapshot = {
  unitId: string;
  name: string | null;
  unitType: string | null;
  ownershipShareValue: number | null;
  livingSpace: number | null;
  usableFloorSpace: number | null;
  additionalHeatingArea: number | null;
};

const PROPERTY_PUT_STRIP_KEYS = new Set([
  // Response-only / computed — keep PUT closer to UI payload without noise.
  "averageColdRent",
  "totalColdRent",
  "squareMeterPriceForLivingSpace",
  "numberOfUnitsPerType",
  "unitAmount",
  "totalLivingSpace",
  "propertyBalance",
  "rentBalance",
  "operatingCostBalance",
  "otherReceivablesBalance",
  "awaitingRentAmount",
  "awaitingRentCount",
  "hasRentUpdateDraft",
  "consideredRentStartDateIsInTheFuture",
]);

const UNIT_PUT_STRIP_KEYS = new Set([
  "currentTenanciesInfo",
  "tenancyInfoList",
  "unitRentsOpenAmount",
  "rentOpenAmount",
  "operatingCostOpenAmount",
  "otherReceivablesOpenAmount",
  "totalSpace",
  "owners",
  "propertyManagementContacts",
  "consideredRentStartDate",
]);

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function unitAccountingSnapshot(
  unit: Record<string, unknown>,
): UnitAccountingSnapshot {
  return {
    unitId: typeof unit.id === "string" ? unit.id : "",
    name: typeof unit.name === "string" ? unit.name : null,
    unitType: typeof unit.unitType === "string" ? unit.unitType : null,
    ownershipShareValue: asNumber(unit.ownershipShareValue),
    livingSpace: asNumber(unit.livingSpace),
    usableFloorSpace: asNumber(unit.usableFloorSpace),
    additionalHeatingArea: asNumber(unit.additionalHeatingArea),
  };
}

function stripUnitForPropertyPut(
  unit: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(unit)) {
    if (UNIT_PUT_STRIP_KEYS.has(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function stripPropertyForAccountingPut(
  property: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(property)) {
    if (PROPERTY_PUT_STRIP_KEYS.has(key)) {
      continue;
    }
    if (key === "units" && Array.isArray(value)) {
      out.units = value
        .filter(isRecord)
        .map((unit) => stripUnitForPropertyPut(unit));
      continue;
    }
    out[key] = value;
  }
  return out;
}

function applyPatchToUnit(
  unit: Record<string, unknown>,
  patch: UnitAccountingPatch,
): Record<string, unknown> {
  const next = { ...unit };
  if (patch.ownershipShareValue !== undefined) {
    next.ownershipShareValue = patch.ownershipShareValue;
  }
  if (patch.livingSpace !== undefined) {
    next.livingSpace = patch.livingSpace;
    // Keep spaceHistory in sync when Immocloud stores historic m² rows.
    if (Array.isArray(next.spaceHistory) && next.spaceHistory.length > 0) {
      const last = next.spaceHistory[next.spaceHistory.length - 1];
      if (isRecord(last)) {
        const usable =
          patch.usableFloorSpace !== undefined
            ? patch.usableFloorSpace
            : patch.livingSpace;
        next.spaceHistory = [
          ...next.spaceHistory.slice(0, -1),
          {
            ...last,
            squareMeters: patch.livingSpace,
            usableFloorSpaceSquareMeters:
              typeof last.usableFloorSpaceSquareMeters === "number" ||
              patch.usableFloorSpace !== undefined
                ? usable
                : last.usableFloorSpaceSquareMeters,
          },
        ];
      }
    }
  }
  if (patch.usableFloorSpace !== undefined) {
    next.usableFloorSpace = patch.usableFloorSpace;
  }
  if (patch.additionalHeatingArea !== undefined) {
    next.additionalHeatingArea = patch.additionalHeatingArea;
  }
  return next;
}

export function buildPropertyAccountingPutBody(
  property: Record<string, unknown>,
  patches: UnitAccountingPatch[],
  options?: {
    ownershipShareOther?: number;
    ownershipShareDistributionKeyNote?: string;
  },
): {
  body: Record<string, unknown>;
  before: UnitAccountingSnapshot[];
  expected: UnitAccountingSnapshot[];
} {
  if (!Array.isArray(property.units)) {
    throw new Error("Property has no units[] — cannot update Abrechnungsdaten.");
  }

  const existingUnits = Array.isArray(property.units) ? property.units : [];
  const patchById = new Map(patches.map((p) => [p.unitId, p]));
  const missing = patches
    .map((p) => p.unitId)
    .filter(
      (id) =>
        !existingUnits.some(
          (unit: unknown) => isRecord(unit) && unit.id === id,
        ),
    );
  if (missing.length > 0) {
    throw new Error(
      `Unknown unitId(s) on property: ${missing.join(", ")}`,
    );
  }

  const before: UnitAccountingSnapshot[] = [];
  const expected: UnitAccountingSnapshot[] = [];
  const units = existingUnits.map((unit: unknown) => {
    if (!isRecord(unit) || typeof unit.id !== "string") {
      return unit;
    }
    const patch = patchById.get(unit.id);
    if (!patch) {
      return stripUnitForPropertyPut(unit);
    }
    before.push(unitAccountingSnapshot(unit));
    const patched = applyPatchToUnit(unit, patch);
    expected.push(unitAccountingSnapshot(patched));
    return stripUnitForPropertyPut(patched);
  });

  const body = stripPropertyForAccountingPut({
    ...property,
    units,
  });

  if (options?.ownershipShareOther !== undefined) {
    body.ownershipShareOther = options.ownershipShareOther;
  }
  if (options?.ownershipShareDistributionKeyNote !== undefined) {
    body.ownershipShareDistributionKeyNote =
      options.ownershipShareDistributionKeyNote;
  }

  return { body, before, expected };
}

function nearlyEqual(a: number | null, b: number | null): boolean {
  if (a === null && b === null) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  return Math.abs(a - b) < 1e-9;
}

export function assertUnitAccountingApplied(
  propertyAfter: Record<string, unknown>,
  expected: UnitAccountingSnapshot[],
): UnitAccountingSnapshot[] {
  if (!Array.isArray(propertyAfter.units)) {
    throw new Error("Property response after accounting update has no units[].");
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const unit of propertyAfter.units) {
    if (isRecord(unit) && typeof unit.id === "string") {
      byId.set(unit.id, unit);
    }
  }

  const after: UnitAccountingSnapshot[] = [];
  for (const exp of expected) {
    const unit = byId.get(exp.unitId);
    if (!unit) {
      throw new Error(
        `Unit ${exp.unitId} missing after Abrechnungsdaten update.`,
      );
    }
    const snap = unitAccountingSnapshot(unit);
    after.push(snap);
    const checks: Array<[string, number | null, number | null]> = [
      ["ownershipShareValue", exp.ownershipShareValue, snap.ownershipShareValue],
      ["livingSpace", exp.livingSpace, snap.livingSpace],
      ["usableFloorSpace", exp.usableFloorSpace, snap.usableFloorSpace],
      [
        "additionalHeatingArea",
        exp.additionalHeatingArea,
        snap.additionalHeatingArea,
      ],
    ];
    for (const [field, want, got] of checks) {
      // Only assert fields that were part of the expected snapshot change path
      // (expected always mirrors patched unit, including unchanged siblings).
      if (!nearlyEqual(want, got)) {
        throw new Error(
          `Abrechnungsdaten not persisted for unit ${exp.unitId} (${snap.name ?? "?"}): ${field} expected ${want}, got ${got}. Immocloud may require PUT /properties/{id} (not unit PUT) for MEA.`,
        );
      }
    }
  }
  return after;
}

export function accountingFieldPresent(
  patch: UnitAccountingPatch,
): boolean {
  return (
    patch.ownershipShareValue !== undefined ||
    patch.livingSpace !== undefined ||
    patch.usableFloorSpace !== undefined ||
    patch.additionalHeatingArea !== undefined
  );
}
