import type { Model } from "@opencode/plugin";
import type { Plugin } from "@opencode/plugin";
import {
  OPENCODE_MODEL_DEFINITIONS,
  type ModelVariant,
} from "../plugin/config/models";
import { V2_PROVIDER_ID } from "./constants";

function toVariantSettings(variant: ModelVariant): Record<string, unknown> | undefined {
  const settings: Record<string, unknown> = {};
  if (variant.thinkingLevel) {
    settings.thinkingLevel = variant.thinkingLevel;
  }
  if (variant.thinkingConfig) {
    settings.thinkingConfig = { ...variant.thinkingConfig };
  }
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/**
 * Converts the shared V1 model definitions into V2 `Model.Info` entries.
 *
 * IDs are kept identical (`antigravity-...`, `gemini-...-preview`) so model
 * references stay stable across plugin versions. Costs are zero (same as the
 * V1 loader, which zeroed costs) because Antigravity uses Google quota, not
 * metered billing. V1 `variants` objects become V2 variant arrays; the
 * `thinkingLevel` / `thinkingConfig` settings are interpreted by the request
 * hook ported in Phase 3.
 */
export function buildV2Models(): Model.Info[] {
  return Object.entries(OPENCODE_MODEL_DEFINITIONS).map(([id, def]) => ({
    id: id as Model.Info["id"],
    modelID: id as Model.Info["modelID"],
    providerID: V2_PROVIDER_ID as Model.Info["providerID"],
    name: def.name,
    capabilities: {
      tools: true,
      input: [...def.modalities.input],
      output: [...def.modalities.output],
    },
    variants: Object.entries(def.variants ?? {}).map(([variantId, variant]) => {
      const settings = toVariantSettings(variant);
      return {
        id: variantId as Model.Info["variants"][number]["id"],
        ...(settings ? { settings } : {}),
      };
    }),
    time: { released: 0 },
    cost: [
      {
        input: 0 as Model.Info["cost"][number]["input"],
        output: 0 as Model.Info["cost"][number]["output"],
        cache: {
          read: 0 as Model.Info["cost"][number]["cache"]["read"],
          write: 0 as Model.Info["cost"][number]["cache"]["write"],
        },
      },
    ],
    status: "active" as const,
    enabled: true,
    limit: { context: def.limit.context, output: def.limit.output },
  }));
}

/**
 * Appends the Antigravity models to the builtin `google` provider inventory.
 *
 * V2 has no "add one model" API, so the existing inventory is read and
 * re-set with ours appended (skipping IDs that already exist, making the
 * transform idempotent across reloads). Existing builtin models are
 * preserved untouched.
 */
export async function registerAntigravityModels(ctx: Plugin.Context): Promise<void> {
  const ours = buildV2Models();
  await ctx.provider.transform((editor) => {
    const record = editor.get(V2_PROVIDER_ID);
    if (!record) {
      throw new Error(`Provider "${V2_PROVIDER_ID}" not found; cannot register Antigravity models.`);
    }
    const seen = new Set<string>(record.models.keys());
    const merged = [...record.models.values()];
    for (const model of ours) {
      const modelId = model.id as string;
      if (!seen.has(modelId)) {
        merged.push(model);
        seen.add(modelId);
      }
    }
    editor.models.set(V2_PROVIDER_ID, merged);
  });
}
