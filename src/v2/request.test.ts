import { describe, expect, it, vi } from "vitest";

// src/v2/request.ts transitively imports the V1 module, which depends on
// `@opencode-ai/plugin` (Bun-only resolution). Mock it like the V1 suites do.
vi.mock("@opencode-ai/plugin", () => ({ tool: vi.fn() }));

import { applyVariantSuffix } from "./request";

const URL =
  "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash:streamGenerateContent";

describe("applyVariantSuffix", () => {
  it("appends the variant when the URL model has no tier suffix", () => {
    expect(applyVariantSuffix(URL, "antigravity-gemini-3.8-flash", "high")).toContain(
      "/models/antigravity-gemini-3.8-flash-high:",
    );
  });

  it("leaves the URL untouched when it already carries a tier suffix", () => {
    const suffixed = URL.replace("3.8-flash:", "3.8-flash-high:");
    expect(applyVariantSuffix(suffixed, "antigravity-gemini-3.8-flash-high", "low")).toBe(suffixed);
  });

  it("leaves the URL untouched without variant or model", () => {
    expect(applyVariantSuffix(URL, "antigravity-gemini-3.8-flash", undefined)).toBe(URL);
    expect(applyVariantSuffix(URL, null, "high")).toBe(URL);
  });
});
