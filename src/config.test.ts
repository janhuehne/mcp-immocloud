import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_BASE_URL, loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("defaults write tools off and pins the API origin", () => {
    const config = loadConfig({
      IMMOCLOUD_AUTH_MODE: "token",
    });
    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.equal(config.enableBankingWriteTools, false);
    assert.equal(config.enablePropertyWriteTools, false);
    assert.equal(config.readOnly, false);
    assert.equal(config.enableLoginTools, false);
  });

  it("READ_ONLY overrides write enable flags", () => {
    const config = loadConfig({
      IMMOCLOUD_AUTH_MODE: "token",
      IMMOCLOUD_READ_ONLY: "true",
      IMMOCLOUD_ENABLE_BANKING_WRITE_TOOLS: "true",
      IMMOCLOUD_ENABLE_PROPERTY_WRITE_TOOLS: "true",
    });
    assert.equal(config.readOnly, true);
    assert.equal(config.enableBankingWriteTools, false);
    assert.equal(config.enablePropertyWriteTools, false);
  });

  it("rejects non-pinned base URLs", () => {
    assert.throws(
      () =>
        loadConfig({
          IMMOCLOUD_BASE_URL: "https://evil.example/api",
        }),
      /pinned/,
    );
    assert.throws(
      () =>
        loadConfig({
          IMMOCLOUD_BASE_URL: "http://app.immocloud.de/api",
        }),
      /https/,
    );
  });

  it("disables private API credentials in oauth mode", () => {
    const config = loadConfig({
      IMMOCLOUD_AUTH_MODE: "oauth",
      IMMOCLOUD_AUTH_TOKEN: "Bearer test-token",
      IMMOCLOUD_ENABLE_LOGIN_TOOLS: "true",
      IMMOCLOUD_ENABLE_BANKING_WRITE_TOOLS: "true",
    });
    assert.equal(config.authMode, "oauth");
    assert.equal(config.authToken, undefined);
    assert.equal(config.enableLoginTools, false);
    assert.equal(config.enableBankingWriteTools, false);
  });
});
