import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { redactSensitive, redactSensitiveString } from "./redaction.js";

describe("redaction", () => {
  it("redacts bearer tokens and emails in strings", () => {
    const out = redactSensitiveString(
      'Authorization Bearer abc.def.ghi email=user@example.com',
    );
    assert.match(out, /Bearer \[REDACTED\]/);
    assert.match(out, /\[REDACTED\]/);
    assert.doesNotMatch(out, /abc\.def\.ghi/);
    assert.doesNotMatch(out, /user@example\.com/);
  });

  it("redacts sensitive object keys recursively", () => {
    const out = redactSensitive({
      password: "secret",
      nested: { refreshToken: "tok", ok: 1 },
      list: [{ deviceId: "d-1" }],
    }) as Record<string, unknown>;

    assert.equal(out.password, "[REDACTED]");
    assert.equal((out.nested as Record<string, unknown>).refreshToken, "[REDACTED]");
    assert.equal((out.nested as Record<string, unknown>).ok, 1);
    assert.equal(
      ((out.list as unknown[])[0] as Record<string, unknown>).deviceId,
      "[REDACTED]",
    );
  });
});
