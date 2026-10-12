import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRefreshUnitMasterDataBody,
  snapshotOperatingCostUnits,
} from "./recalculate.js";

const STATEMENT = {
  id: "stmt1",
  propertyId: "prop1",
  startDate: "2025-01-01",
  endDate: "2025-12-31",
  type: "FULL",
  title: "NK 2025",
  prepaidCostStrategy: "ALL",
  itemizeReceipts: false,
  printReceiptDates: true,
  unitIds: ["u1", "u2", "prop1"],
  absentUnitIds: [],
  unitResultList: [
    {
      unitId: "u1",
      unitName: "App. 122",
      ownershipShareValue: 41.985,
      livingSpace: 19.82,
    },
    {
      unitId: "u2",
      unitName: "App. 139",
      ownershipShareValue: 38.387,
      livingSpace: 17.7,
      usableFloorSpace: 0,
    },
    {
      unitId: "prop1",
      unitName: "Andere Einheiten",
      ownershipShareValue: 9820.632,
      livingSpace: 5234.34,
    },
  ],
};

describe("snapshotOperatingCostUnits", () => {
  it("marks property aggregate as virtual", () => {
    const snaps = snapshotOperatingCostUnits(STATEMENT);
    assert.equal(snaps.length, 3);
    assert.equal(snaps.find((s) => s.unitId === "prop1")?.virtual, true);
    assert.equal(snaps.find((s) => s.unitId === "u2")?.ownershipShareValue, 38.387);
  });
});

describe("buildRefreshUnitMasterDataBody", () => {
  it("strips propertyId from unitIds and sets Update DTO className", () => {
    const body = buildRefreshUnitMasterDataBody(STATEMENT, "stmt1");
    assert.equal(body.className, "UpdateOperatingCostStatementDto");
    assert.equal(body.id, "stmt1");
    assert.equal(body.propertyId, "prop1");
    assert.deepEqual(body.unitIds, ["u1", "u2"]);
    assert.equal(body.printReceiptDates, true);
  });

  it("falls back to unitResultList when unitIds empty", () => {
    const body = buildRefreshUnitMasterDataBody(
      { ...STATEMENT, unitIds: [] },
      "stmt1",
    );
    assert.deepEqual(body.unitIds, ["u1", "u2"]);
  });

  it("rejects statements without units", () => {
    assert.throws(
      () =>
        buildRefreshUnitMasterDataBody(
          { ...STATEMENT, unitIds: [], unitResultList: [] },
          "stmt1",
        ),
      /no unitIds/,
    );
  });
});
