import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  encodeImmocloudId,
  isImmocloudId,
  normalizeImmocloudId,
} from "./ids.js";

describe("immocloud ids", () => {
  it("accepts numeric, ObjectId, and UUID ids", () => {
    assert.equal(isImmocloudId("1234567890"), true);
    assert.equal(isImmocloudId("696f361c7bf98035691ccf32"), true);
    assert.equal(
      isImmocloudId("696f361c-7bf9-8035-691c-cf32691ccf32"),
      true,
    );
  });

  it("rejects path traversal and empty junk", () => {
    assert.equal(isImmocloudId("."), false);
    assert.equal(isImmocloudId(".."), false);
    assert.equal(isImmocloudId("../x"), false);
    assert.equal(isImmocloudId(""), false);
    assert.equal(isImmocloudId("not an id"), false);
    assert.equal(isImmocloudId("696f361c7bf98035691ccf3"), false); // 23 hex
  });

  it("encodes only after validation", () => {
    assert.equal(encodeImmocloudId("42"), "42");
    assert.equal(
      encodeImmocloudId("696f361c7bf98035691ccf32"),
      "696f361c7bf98035691ccf32",
    );
    assert.throws(() => normalizeImmocloudId(".."), /ObjectId|UUID/);
    assert.throws(() => encodeImmocloudId(".."), /ObjectId|UUID/);
  });
});
