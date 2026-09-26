import { describe, expect, it } from "vitest";
import { OPENCODE_MODEL_DEFINITIONS } from "../plugin/config/models";
import { buildV2Models } from "./models";

describe("buildV2Models", () => {
  it("converts every V1 definition with stable ids", () => {
    const models = buildV2Models();
    expect(models.map((m) => m.id as string).sort()).toEqual(
      Object.keys(OPENCODE_MODEL_DEFINITIONS).sort(),
    );
  });

  it("zeroes costs and marks models active", () => {
    for (const model of buildV2Models()) {
      expect(model.cost).toHaveLength(1);
      expect(model.cost[0]?.input).toBe(0);
      expect(model.cost[0]?.output).toBe(0);
      expect(model.status).toBe("active");
      expect(model.enabled).toBe(true);
      expect(model.providerID as string).toBe("google");
    }
  });

  it("maps V1 variant objects to V2 variant arrays", () => {
    const byId = new Map(buildV2Models().map((m) => [m.id as string, m]));
    const flash = byId.get("antigravity-gemini-3.8-flash");
    expect(flash?.variants.map((v) => v.id as string).sort()).toEqual([
      "high",
      "low",
      "medium",
      "minimal",
    ]);
    const high = flash?.variants.find((v) => (v.id as string) === "high");
    expect(high).toMatchObject({ settings: { thinkingLevel: "high" } });

    const opus = byId.get("antigravity-claude-opus-4-6-thinking");
    const max = opus?.variants.find((v) => (v.id as string) === "max");
    expect(max).toMatchObject({ settings: { thinkingConfig: { thinkingBudget: 32768 } } });

    const plain = byId.get("gpt-oss-120b-medium");
    expect(plain?.variants).toEqual([]);
  });
});
