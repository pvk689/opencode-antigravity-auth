import { describe, it, expect, afterEach } from "vitest";
import {
  getAgyTokenPaths,
  findAgyTokenPath,
  hasAgyToken,
  readAgyTokenRaw,
  importAgyToken,
} from "./agy-importer";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("agy-importer", () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const f of tempFiles) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
    tempFiles.length = 0;
  });

  function createTempTokenFile(content: string): string {
    const tmpPath = path.join(os.tmpdir(), `test-token-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(tmpPath, content, "utf8");
    tempFiles.push(tmpPath);
    return tmpPath;
  }

  it("getAgyTokenPaths returns standard locations in .gemini", () => {
    const paths = getAgyTokenPaths();
    expect(paths.length).toBeGreaterThanOrEqual(2);
    expect(paths.some((p) => p.includes("jetski-standalone-oauth-token"))).toBe(true);
    expect(paths.some((p) => p.includes("antigravity-oauth-token"))).toBe(true);
  });

  describe("readAgyTokenRaw", () => {
    it("returns null for non-existent file", async () => {
      const result = await readAgyTokenRaw("/non/existent/path/token.json");
      expect(result).toBeNull();
    });

    it("parses valid token json correctly", async () => {
      const mockToken = {
        auth_method: "consumer",
        token: {
          access_token: "test-access",
          refresh_token: "test-refresh",
          token_type: "Bearer",
          expiry: "2099-01-01T00:00:00Z",
        },
      };

      const tmpFile = createTempTokenFile(JSON.stringify(mockToken));
      const result = await readAgyTokenRaw(tmpFile);
      expect(result).toEqual(mockToken);
    });
  });

  describe("importAgyToken", () => {
    it("returns failed when no token file exists", async () => {
      const result = await importAgyToken({ tokenPath: "/non/existent/token.json" });
      expect(result.type).toBe("failed");
    });

    it("returns failed when token is missing refresh token", async () => {
      const tmpFile = createTempTokenFile(
        JSON.stringify({ token: { access_token: "only-access" } })
      );

      const result = await importAgyToken({ tokenPath: tmpFile });
      expect(result.type).toBe("failed");
      if (result.type === "failed") {
        expect(result.error).toContain("refresh token");
      }
    });

    it("successfully imports valid token from file", async () => {
      const validToken = {
        auth_method: "consumer",
        token: {
          access_token: "mock-valid-access",
          refresh_token: "1//mock-refresh-token",
          token_type: "Bearer",
          expiry: new Date(Date.now() + 3600_000).toISOString(),
        },
      };

      const tmpFile = createTempTokenFile(JSON.stringify(validToken));
      const result = await importAgyToken({ tokenPath: tmpFile, projectId: "test-project" });
      expect(result.type).toBe("success");
      if (result.type === "success") {
        expect(result.access).toBe("mock-valid-access");
        expect(result.projectId).toBe("test-project");
        expect(result.refresh).toContain("1//mock-refresh-token");
      }
    });
  });
});
