import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  listTenancyTargetsFromStatement,
  resolveDownloadsDir,
  slugFilenamePart,
} from "./download.js";

describe("slugFilenamePart", () => {
  it("removes path separators and spaces", () => {
    assert.equal(
      slugFilenamePart("WG 067 / App. 122"),
      "WG_067_-_App._122",
    );
  });

  it("falls back when empty", () => {
    assert.equal(slugFilenamePart("***"), "file");
  });
});

describe("resolveDownloadsDir", () => {
  it("resolves under ./downloads", () => {
    const dir = resolveDownloadsDir("rs810-bka-2025");
    assert.equal(dir, path.resolve(process.cwd(), "downloads", "rs810-bka-2025"));
  });

  it("rejects path escape", () => {
    assert.throws(
      () => resolveDownloadsDir("../secrets"),
      /must stay under/,
    );
  });
});

describe("listTenancyTargetsFromStatement", () => {
  it("skips Andere Einheiten and dedupes tenancies", () => {
    const prop = "prop1";
    const targets = listTenancyTargetsFromStatement({
      propertyId: prop,
      unitResultList: [
        {
          unitId: "u1",
          unitName: "App. 122",
          tenants: [{ tenancyId: "t1", tenantName: "Beyer" }],
        },
        {
          unitId: prop,
          unitName: "Andere Einheiten",
          tenants: [{ tenancyId: "tX", tenantName: "Ignore" }],
        },
        {
          unitId: "u2",
          unitName: "App. 204",
          tenants: [
            { tenancyId: "t2", tenantName: "Kim" },
            { tenancyId: "t2", tenantName: "Kim dup" },
            { tenancyId: "t3", tenantName: "Jung" },
          ],
        },
      ],
    });
    assert.deepEqual(
      targets.map((t) => t.tenancyId),
      ["t1", "t2", "t3"],
    );
    assert.equal(targets[0]?.tenantName, "Beyer");
    assert.equal(targets[2]?.unitName, "App. 204");
  });
});
