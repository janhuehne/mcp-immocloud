/** Immocloud operating-cost (BKA / Nebenkosten) API shapes. */

export const OPERATING_COST_STATUSES = [
  "CREATED",
  "IN_PROGRESS",
  "FINISHED",
  "SEND",
  "CORRECTION_IN_PROGRESS",
  "CORRECTION_DISCARDED",
  "SUPERSEDED",
] as const;

export type OperatingCostStatus = (typeof OPERATING_COST_STATUSES)[number];

export const OPERATING_COST_TYPES = ["FULL", "EASY"] as const;
export type OperatingCostType = (typeof OPERATING_COST_TYPES)[number];

export const PREPAID_COST_STRATEGIES = [
  "ALL",
  "ADDITIONAL_COSTS",
  "HEATING_COSTS",
] as const;
export type PrepaidCostStrategy = (typeof PREPAID_COST_STRATEGIES)[number];

export const DISTRIBUTION_KEY_TYPES = [
  "LIVING_SPACE",
  "USABLE_FLOOR_SPACE",
  "TOTAL_AREA",
  "HEATING_AREA",
  "COMBINED_HEATING_AREA",
  "NO_OF_PERSONS",
  "UNITS",
  "CONSUMPTION",
  "OWNERSHIP",
  "DIRECT",
  "CUSTOM",
  "COMPOSITE",
] as const;
export type DistributionKeyType = (typeof DISTRIBUTION_KEY_TYPES)[number];

export type DistributionKeyRef = {
  id?: string;
  type: DistributionKeyType;
  name?: string;
  measuringUnit?: string;
  note?: string;
  total?: number;
  unitDistributionKeys?: Record<string, unknown>;
  components?: unknown[];
};

export type CostEntryUnitRef = {
  unitId: string;
  tenantIdList?: string[];
};

export type OperatingCostEntryInput = {
  assignedCostCategoryId: number;
  value: number;
  vatAmountInPercent?: number;
  tag?: string;
  description?: string;
  distributionKey: DistributionKeyRef;
  unitIdList?: CostEntryUnitRef[];
  objectRelatedEntry?: boolean;
  externalAllocationOverrides?: Record<string, number>;
  meters?: unknown[];
  transactions?: unknown[];
};

export function summarizeOperatingCostStatement(raw: unknown): {
  id: string;
  title: string | null;
  propertyId: string | null;
  propertyName: string | null;
  status: string | null;
  type: string | null;
  startDate: string | null;
  endDate: string | null;
  numberOfUnits: number | null;
  costEntryCount: number;
  prepaidCostStrategy: string | null;
  isValid: boolean | null;
} | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return null;
  return {
    id: o.id,
    title: typeof o.title === "string" ? o.title : null,
    propertyId: typeof o.propertyId === "string" ? o.propertyId : null,
    propertyName: typeof o.propertyName === "string" ? o.propertyName : null,
    status: typeof o.status === "string" ? o.status : null,
    type: typeof o.type === "string" ? o.type : null,
    startDate: typeof o.startDate === "string" ? o.startDate : null,
    endDate: typeof o.endDate === "string" ? o.endDate : null,
    numberOfUnits:
      typeof o.numberOfUnits === "number" ? o.numberOfUnits : null,
    costEntryCount: Array.isArray(o.costEntryList) ? o.costEntryList.length : 0,
    prepaidCostStrategy:
      typeof o.prepaidCostStrategy === "string" ? o.prepaidCostStrategy : null,
    isValid: typeof o.isValid === "boolean" ? o.isValid : null,
  };
}
