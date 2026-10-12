/**
 * Immocloud Kontenrahmen / cost-category helpers.
 * Categories are keyed by numeric technicalId (not Mongo ObjectId).
 */

export const COST_CATEGORY_TYPES = [
  "ACQUISITION_COST",
  "FINANCE_COST",
  "OPERATING_COST",
  "OTHER_EXPENSES",
  "OTHER_REVENUE",
  "RENOVATION_COST",
  "RENT_COST",
] as const;

export type CostCategoryType = (typeof COST_CATEGORY_TYPES)[number];

export type CostCategorySummary = {
  technicalId: number;
  categoryType: string;
  level1: string;
  level2: string;
  tag: string;
  allocable: boolean;
  vatRate: number;
  bookingAccountNumber?: string;
  defaultCostCategory: boolean;
  technicalCostCategory: boolean;
  distributionKey?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeCostCategory(value: unknown): CostCategorySummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const technicalId = value.technicalId;
  if (typeof technicalId !== "number" || !Number.isFinite(technicalId)) {
    return null;
  }
  const summary: CostCategorySummary = {
    technicalId,
    categoryType: String(value.categoryType ?? ""),
    level1: String(value.level1 ?? ""),
    level2: String(value.level2 ?? ""),
    tag: String(value.tag ?? ""),
    allocable: value.allocable === true,
    vatRate: typeof value.vatRate === "number" ? value.vatRate : 0,
    defaultCostCategory: value.defaultCostCategory === true,
    technicalCostCategory: value.technicalCostCategory === true,
  };
  if (typeof value.bookingAccountNumber === "string") {
    summary.bookingAccountNumber = value.bookingAccountNumber;
  }
  if (typeof value.distributionKey === "string") {
    summary.distributionKey = value.distributionKey;
  }
  return summary;
}

export function summarizeAccountChart(value: unknown): {
  id: string;
  name: string;
  defaultAccountChart: boolean;
  costCategoryCount: number;
  costCategories: CostCategorySummary[];
} | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value.id;
  if (typeof id !== "string" && typeof id !== "number") {
    return null;
  }
  const categories = Array.isArray(value.costCategories)
    ? value.costCategories
        .map(summarizeCostCategory)
        .filter((c): c is CostCategorySummary => c !== null)
    : [];
  return {
    id: String(id),
    name: String(value.name ?? ""),
    defaultAccountChart: value.defaultAccountChart === true,
    costCategoryCount: categories.length,
    costCategories: categories,
  };
}

export function filterCostCategories(
  categories: CostCategorySummary[],
  options: {
    categoryType?: string;
    query?: string;
    customOnly?: boolean;
  },
): CostCategorySummary[] {
  const q = options.query?.trim().toLowerCase();
  return categories.filter((cat) => {
    if (options.categoryType && cat.categoryType !== options.categoryType) {
      return false;
    }
    if (options.customOnly && cat.defaultCostCategory) {
      return false;
    }
    if (!q) {
      return true;
    }
    const haystack = `${cat.level1} ${cat.level2} ${cat.tag} ${cat.technicalId}`.toLowerCase();
    return haystack.includes(q);
  });
}

export function buildCreateCostCategoryBody(input: {
  categoryType: CostCategoryType;
  level1: string;
  level2: string;
  tag?: string;
  allocable?: boolean;
  vatRate?: number;
  bookingAccountNumber?: string;
  distributionKey?: string;
}): Record<string, unknown> {
  const level1 = input.level1.trim();
  const level2 = input.level2.trim();
  if (!level1 || !level2) {
    throw new Error("level1 and level2 are required.");
  }
  const body: Record<string, unknown> = {
    categoryType: input.categoryType,
    level1,
    level2,
    tag: (input.tag ?? level2).trim(),
    allocable: input.allocable === true,
    vatRate: input.vatRate ?? 0,
  };
  if (input.bookingAccountNumber !== undefined) {
    body.bookingAccountNumber = input.bookingAccountNumber.trim();
  }
  if (input.distributionKey !== undefined) {
    body.distributionKey = input.distributionKey.trim();
  }
  return body;
}

/** Fields Immocloud accepts on create/update of custom cost categories. */
export function buildUpdateCostCategoryBody(
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = [
    "level1",
    "level2",
    "tag",
    "allocable",
    "vatRate",
    "distributionKey",
    "bookingAccountNumber",
  ] as const;
  const body: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      body[key] = patch[key];
    }
  }
  if (Object.keys(body).length === 0) {
    throw new Error(
      "Update body must include at least one of: level1, level2, tag, allocable, vatRate, distributionKey, bookingAccountNumber.",
    );
  }
  return body;
}
