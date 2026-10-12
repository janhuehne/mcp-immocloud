import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCreateCostCategoryBody,
  buildUpdateCostCategoryBody,
  filterCostCategories,
  summarizeAccountChart,
  summarizeCostCategory,
  type CostCategorySummary,
} from "./costCategories.js";

describe("summarizeCostCategory", () => {
  it("maps Immocloud cost-category fields", () => {
    const summary = summarizeCostCategory({
      technicalId: 505,
      categoryType: "OTHER_REVENUE",
      level1: "Sonstige Einnahmen",
      level2: "Umbuchung Rücklage",
      tag: "Umb. Rücklage",
      allocable: false,
      vatRate: 0,
      bookingAccountNumber: "1890",
      defaultCostCategory: false,
      technicalCostCategory: false,
    });
    assert.deepEqual(summary, {
      technicalId: 505,
      categoryType: "OTHER_REVENUE",
      level1: "Sonstige Einnahmen",
      level2: "Umbuchung Rücklage",
      tag: "Umb. Rücklage",
      allocable: false,
      vatRate: 0,
      bookingAccountNumber: "1890",
      defaultCostCategory: false,
      technicalCostCategory: false,
    });
  });

  it("rejects missing technicalId", () => {
    assert.equal(summarizeCostCategory({ level2: "x" }), null);
  });
});

describe("summarizeAccountChart", () => {
  it("summarizes chart and nested categories", () => {
    const chart = summarizeAccountChart({
      id: "696f361c7bf98035691ccf45",
      name: "Standard Kontenrahmen",
      defaultAccountChart: true,
      costCategories: [
        {
          technicalId: 505,
          categoryType: "OTHER_REVENUE",
          level1: "Sonstige Einnahmen",
          level2: "Umbuchung Rücklage",
          tag: "Umb. Rücklage",
          allocable: false,
          vatRate: 0,
          defaultCostCategory: false,
        },
      ],
    });
    assert.equal(chart?.id, "696f361c7bf98035691ccf45");
    assert.equal(chart?.costCategoryCount, 1);
    assert.equal(chart?.costCategories[0]?.technicalId, 505);
  });
});

describe("filterCostCategories", () => {
  const cats: CostCategorySummary[] = [
    {
      technicalId: 117,
      categoryType: "OTHER_REVENUE",
      level1: "Sonstige Einnahmen",
      level2: "Privateinlage",
      tag: "Privateinlage",
      allocable: false,
      vatRate: 0,
      defaultCostCategory: true,
      technicalCostCategory: false,
    },
    {
      technicalId: 505,
      categoryType: "OTHER_REVENUE",
      level1: "Sonstige Einnahmen",
      level2: "Umbuchung Rücklage",
      tag: "Umb. Rücklage",
      allocable: false,
      vatRate: 0,
      defaultCostCategory: false,
      technicalCostCategory: false,
    },
    {
      technicalId: 506,
      categoryType: "OTHER_EXPENSES",
      level1: "Sonstige Ausgaben",
      level2: "Umbuchung Rücklage",
      tag: "Umb. Rücklage",
      allocable: false,
      vatRate: 0,
      defaultCostCategory: false,
      technicalCostCategory: false,
    },
  ];

  it("filters by type, query, and customOnly", () => {
    assert.equal(
      filterCostCategories(cats, { categoryType: "OTHER_REVENUE" }).length,
      2,
    );
    assert.equal(
      filterCostCategories(cats, { query: "rücklage", customOnly: true }).length,
      2,
    );
    assert.equal(
      filterCostCategories(cats, { query: "privateinlage", customOnly: true })
        .length,
      0,
    );
  });
});

describe("buildCreateCostCategoryBody", () => {
  it("defaults tag to level2 and allocable to false", () => {
    assert.deepEqual(
      buildCreateCostCategoryBody({
        categoryType: "OTHER_EXPENSES",
        level1: "Sonstige Ausgaben",
        level2: "Umbuchung Rücklage",
      }),
      {
        categoryType: "OTHER_EXPENSES",
        level1: "Sonstige Ausgaben",
        level2: "Umbuchung Rücklage",
        tag: "Umbuchung Rücklage",
        allocable: false,
        vatRate: 0,
      },
    );
  });
});

describe("buildUpdateCostCategoryBody", () => {
  it("keeps only allowed fields", () => {
    assert.deepEqual(
      buildUpdateCostCategoryBody({
        tag: "Umb. RL",
        categoryType: "OTHER_REVENUE",
        technicalId: 505,
      }),
      { tag: "Umb. RL" },
    );
  });

  it("rejects empty patch", () => {
    assert.throws(() => buildUpdateCostCategoryBody({ categoryType: "x" }), {
      message: /at least one of/,
    });
  });
});
