import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fetchQuotaSnapshot, formatReset, quotaBar, toneFor } from "./quota";

describe("toneFor", () => {
  it("grades remaining fractions", () => {
    expect(toneFor(0.9)).toBe("success");
    expect(toneFor(0.5)).toBe("warning");
    expect(toneFor(0.1)).toBe("error");
    expect(toneFor(undefined)).toBe("muted");
  });
});

describe("quotaBar", () => {
  it("renders a fixed-width bar with percent", () => {
    expect(quotaBar(1, 4)).toBe("████ 100%");
    expect(quotaBar(0.5, 4)).toBe("██░░  50%");
    expect(quotaBar(undefined, 4)).toContain("???");
  });
});

describe("formatReset", () => {
  it("formats seconds, minutes, hours and days", () => {
    const now = Date.now();
    expect(formatReset(new Date(now + 30_000).toISOString())).toContain("30s");
    expect(formatReset(new Date(now + 5 * 60_000).toISOString())).toContain("5m");
    expect(formatReset(new Date(now + 2 * 3600_000).toISOString())).toContain("2h");
    expect(formatReset(undefined)).toBe("");
    expect(formatReset("not-a-date")).toBe("");
  });
});

describe("fetchQuotaSnapshot", () => {
  const originalEnv = process.env.OPENCODE_CONFIG_DIR;
  let tempDir = "";

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalEnv !== undefined) {
      process.env.OPENCODE_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.OPENCODE_CONFIG_DIR;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("returns an empty snapshot when no pool exists", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tui-test-"));
    vi.stubEnv("OPENCODE_CONFIG_DIR", tempDir);
    const snapshot = await fetchQuotaSnapshot();
    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.error).toBeUndefined();
  });
});
