import type { ImmocloudClient } from "../immocloud/client.js";
import { encodeImmocloudId } from "../immocloud/ids.js";

export type OperatingCostUnitSnapshot = {
  unitId: string;
  unitName: string | null;
  ownershipShareValue: number | null;
  livingSpace: number | null;
  usableFloorSpace: number | null;
  virtual: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Compact per-unit MEA / Wohnfläche snapshot from a BKA statement. */
export function snapshotOperatingCostUnits(
  statement: unknown,
): OperatingCostUnitSnapshot[] {
  const root = asRecord(statement);
  if (!root) return [];
  const propertyId =
    typeof root.propertyId === "string" ? root.propertyId : undefined;
  const list = Array.isArray(root.unitResultList) ? root.unitResultList : [];
  const out: OperatingCostUnitSnapshot[] = [];
  for (const row of list) {
    const u = asRecord(row);
    if (!u || typeof u.unitId !== "string") continue;
    out.push({
      unitId: u.unitId,
      unitName: typeof u.unitName === "string" ? u.unitName : null,
      ownershipShareValue: numOrNull(u.ownershipShareValue),
      livingSpace: numOrNull(u.livingSpace),
      usableFloorSpace: numOrNull(u.usableFloorSpace),
      virtual: Boolean(propertyId && u.unitId === propertyId),
    });
  }
  return out;
}

/**
 * Build Immocloud `UpdateOperatingCostStatementDto` that re-binds the same
 * units. A bare `/calculate` does **not** reload MEA/Wohnfläche from property
 * master data — re-PUTting `unitIds` does.
 */
export function buildRefreshUnitMasterDataBody(
  statement: unknown,
  statementId: string,
): Record<string, unknown> {
  const root = asRecord(statement);
  if (!root) {
    throw new Error("Operating-cost statement is not an object.");
  }
  const propertyId = root.propertyId;
  if (typeof propertyId !== "string" || !propertyId) {
    throw new Error("Operating-cost statement is missing propertyId.");
  }

  let unitIds = Array.isArray(root.unitIds)
    ? root.unitIds.filter((id): id is string => typeof id === "string" && !!id)
    : [];
  // Never include the property aggregate row ("Andere Einheiten") as a unit.
  unitIds = unitIds.filter((id) => id !== propertyId);
  if (unitIds.length === 0) {
    // Fall back to non-virtual unitResultList ids
    unitIds = snapshotOperatingCostUnits(statement)
      .filter((u) => !u.virtual)
      .map((u) => u.unitId);
  }
  if (unitIds.length === 0) {
    throw new Error(
      "Cannot refresh unit master data: statement has no unitIds.",
    );
  }

  const absentUnitIds = Array.isArray(root.absentUnitIds)
    ? root.absentUnitIds.filter(
        (id): id is string => typeof id === "string" && !!id,
      )
    : [];

  return {
    className: "UpdateOperatingCostStatementDto",
    id: statementId,
    propertyId,
    startDate: root.startDate,
    endDate: root.endDate,
    type: root.type,
    title: root.title,
    prepaidCostStrategy: root.prepaidCostStrategy,
    unitIds,
    absentUnitIds,
    itemizeReceipts: root.itemizeReceipts ?? false,
    printReceiptDates: root.printReceiptDates ?? false,
  };
}

export type RecalculateOperatingCostResult = {
  statementId: string;
  refreshedUnitMasterData: boolean;
  unitsBefore: OperatingCostUnitSnapshot[];
  unitsAfter: OperatingCostUnitSnapshot[];
  ownershipShareChanges: Array<{
    unitId: string;
    unitName: string | null;
    before: number | null;
    after: number | null;
  }>;
  statement: unknown;
};

/**
 * Recalculate a BKA. When `refreshUnitMasterData` is true (recommended after
 * MEA/Wohnfläche edits), first PUT `/operatingcost/{id}` with the existing
 * unitIds so Immocloud reloads Abrechnungsdaten from the property.
 */
export async function recalculateOperatingCost(
  client: ImmocloudClient,
  options: {
    statementId: string;
    refreshUnitMasterData?: boolean;
  },
): Promise<RecalculateOperatingCostResult> {
  const statementId = encodeImmocloudId(options.statementId, "Statement ID");
  const refresh = options.refreshUnitMasterData !== false;

  const before = await client.get<unknown>(`/operating-cost-v2/${statementId}`);
  const unitsBefore = snapshotOperatingCostUnits(before);

  if (refresh) {
    const body = buildRefreshUnitMasterDataBody(before, statementId);
    await client.put(`/operatingcost/${statementId}`, body);
  }

  await client.put(`/operatingcost/${statementId}/calculate`);
  const after = await client.get<unknown>(`/operating-cost-v2/${statementId}`);
  const unitsAfter = snapshotOperatingCostUnits(after);

  const afterById = new Map(unitsAfter.map((u) => [u.unitId, u]));
  const ownershipShareChanges = unitsBefore
    .filter((u) => !u.virtual)
    .map((u) => {
      const next = afterById.get(u.unitId);
      return {
        unitId: u.unitId,
        unitName: u.unitName,
        before: u.ownershipShareValue,
        after: next?.ownershipShareValue ?? null,
      };
    })
    .filter((row) => row.before !== row.after);

  return {
    statementId,
    refreshedUnitMasterData: refresh,
    unitsBefore,
    unitsAfter,
    ownershipShareChanges,
    statement: after,
  };
}
