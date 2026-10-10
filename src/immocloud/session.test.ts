import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, after } from "node:test";

import { loadSession, saveSession } from "./session.js";

describe("session file backend", () => {
  const dirs: string[] = [];

  after(async () => {
    await Promise.all(
      dirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function tempSessionPath(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "immocloud-session-"));
    dirs.push(dir);
    return path.join(dir, "session.json");
  }

  it("round-trips a file-backed session without keychain", async () => {
    const sessionPath = await tempSessionPath();
    const saved = await saveSession(
      {
        authToken: "Bearer test-token-value",
        deviceId: "device-1",
        origin: "https://app.immocloud.de",
      },
      sessionPath,
      "file",
    );
    assert.equal(saved.backend, "file");

    const loaded = await loadSession(
      sessionPath,
      "https://app.immocloud.de",
      "file",
    );
    assert.ok(loaded);
    assert.equal(loaded.authToken, "Bearer test-token-value");
    assert.equal(loaded.deviceId, "device-1");
    assert.equal(loaded.backend, "file");
  });

  it("rejects sessions bound to another origin", async () => {
    const sessionPath = await tempSessionPath();
    await saveSession(
      {
        authToken: "Bearer test-token-value",
        origin: "https://app.immocloud.de",
      },
      sessionPath,
      "file",
    );
    await assert.rejects(
      () => loadSession(sessionPath, "https://evil.example", "file"),
      /different API origin/,
    );
  });

  it("rejects world-readable session files", async () => {
    const sessionPath = await tempSessionPath();
    await mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
    await writeFile(
      sessionPath,
      JSON.stringify({
        backend: "file",
        authToken: "Bearer test-token-value",
        savedAt: new Date().toISOString(),
      }),
      { mode: 0o644 },
    );
    await chmod(sessionPath, 0o644);
    await assert.rejects(
      () => loadSession(sessionPath, undefined, "file"),
      /permissions are too broad/,
    );
  });

  it("reads legacy plaintext files that omit backend", async () => {
    const sessionPath = await tempSessionPath();
    await mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
    await writeFile(
      sessionPath,
      `${JSON.stringify({
        authToken: "Bearer legacy-token",
        deviceId: "dev",
        savedAt: "2026-01-01T00:00:00.000Z",
        origin: "https://app.immocloud.de",
      })}\n`,
      { mode: 0o600 },
    );

    const loaded = await loadSession(sessionPath, undefined, "file");
    assert.ok(loaded);
    assert.equal(loaded.authToken, "Bearer legacy-token");
    const raw = await readFile(sessionPath, "utf8");
    assert.match(raw, /legacy-token/);
  });
});
