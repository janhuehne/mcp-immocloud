import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertUnitAccountingApplied,
  buildPropertyAccountingPutBody,
  unitAccountingSnapshot,
} from "./accounting.js";

describe("buildPropertyAccountingPutBody", () => {
  it("patches ownershipShareValue via property units[] (UI path)", () => {
    const property = {
      id: "prop1",
      name: "RS810",
      ownershipShareOther: 0,
      ownershipShareDistributionKeyNote: "",
      averageColdRent: 999,
      units: [
        {
          id: "u1",
          name: "App. 122",
          unitType: "FLAT",
          ownershipShareValue: 0,
          livingSpace: 19.82,
          usableFloorSpace: 19.82,
          currentTenanciesInfo: [{ id: "t1" }],
        },
        {
          id: "u2",
          name: "TG16",
          unitType: "PARKING_SPACE",
          ownershipShareValue: 0,
          livingSpace: 0,
          usableFloorSpace: 0,
        },
      ],
    };

    const { body, before, expected } = buildPropertyAccountingPutBody(
      property,
      [{ unitId: "u1", ownershipShareValue: 41.985 }],
      { ownershipShareDistributionKeyNote: "MEA aus Hausgeld 2025" },
    );

    assert.equal(body.averageColdRent, undefined);
    assert.equal(body.ownershipShareDistributionKeyNote, "MEA aus Hausgeld 2025");
    assert.equal(before[0]?.ownershipShareValue, 0);
    assert.equal(expected[0]?.ownershipShareValue, 41.985);

    const units = body.units as Array<Record<string, unknown>>;
    assert.equal(units[0]?.ownershipShareValue, 41.985);
    assert.equal(units[0]?.currentTenanciesInfo, undefined);
    assert.equal(units[1]?.ownershipShareValue, 0);
  });

  it("rejects unknown unit ids", () => {
    assert.throws(
      () =>
        buildPropertyAccountingPutBody(
          { id: "p", units: [{ id: "u1", ownershipShareValue: 0 }] },
          [{ unitId: "missing", ownershipShareValue: 1 }],
        ),
      /Unknown unitId/,
    );
  });
});

describe("assertUnitAccountingApplied", () => {
  it("passes when MEA stuck", () => {
    const after = assertUnitAccountingApplied(
      {
        units: [
          {
            id: "u1",
            name: "App",
            ownershipShareValue: 41.985,
            livingSpace: 19.82,
            usableFloorSpace: 19.82,
            additionalHeatingArea: 0,
          },
        ],
      },
      [
        unitAccountingSnapshot({
          id: "u1",
          name: "App",
          ownershipShareValue: 41.985,
          livingSpace: 19.82,
          usableFloorSpace: 19.82,
          additionalHeatingArea: 0,
        }),
      ],
    );
    assert.equal(after[0]?.ownershipShareValue, 41.985);
  });

  it("fails when MEA still 0 (unit-PUT bug)", () => {
    assert.throws(
      () =>
        assertUnitAccountingApplied(
          {
            units: [
              {
                id: "u1",
                name: "App",
                ownershipShareValue: 0,
                livingSpace: 19.82,
                usableFloorSpace: 19.82,
                additionalHeatingArea: 0,
              },
            ],
          },
          [
            unitAccountingSnapshot({
              id: "u1",
              name: "App",
              ownershipShareValue: 41.985,
              livingSpace: 19.82,
              usableFloorSpace: 19.82,
              additionalHeatingArea: 0,
            }),
          ],
        ),
      /not persisted/,
    );
  });
});
