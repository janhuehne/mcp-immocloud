import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertTenancyPersonsApplied,
  buildTenancyPersonsPutBody,
} from "./tenancyAccounting.js";

describe("buildTenancyPersonsPutBody", () => {
  it("sets numberOfTenants and derives tenantIdList", () => {
    const body = buildTenancyPersonsPutBody(
      {
        id: "t1",
        unitId: "u1",
        contractStart: "2020-03-01",
        contractType: "PERMANENT",
        rentInterval: "MONTHLY",
        tenantList: [{ id: "c1", firstname: "Max", lastname: "Poh" }],
        rents: [{ startDate: "2020-03-01", coldRent: 40 }],
        numberOfTenants: [],
        createdDate: "2026-01-01",
        totalRentAmount: 40,
      },
      [{ startDate: "2020-03-01", numberOfTenants: 0 }],
    );

    assert.deepEqual(body.numberOfTenants, [
      { startDate: "2020-03-01", numberOfTenants: 0 },
    ]);
    assert.deepEqual(body.tenantIdList, ["c1"]);
    assert.deepEqual(body.tenantList, [{ id: "c1" }]);
    assert.equal(body.createdDate, undefined);
    assert.equal(body.totalRentAmount, undefined);
  });
});

describe("assertTenancyPersonsApplied", () => {
  it("accepts matching persons history", () => {
    const got = assertTenancyPersonsApplied(
      {
        numberOfTenants: [{ startDate: "2020-03-01", numberOfTenants: 0 }],
      },
      [{ startDate: "2020-03-01", numberOfTenants: 0 }],
    );
    assert.equal(got[0]?.numberOfTenants, 0);
  });
});
