import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opencode-ai/plugin", () => ({ tool: vi.fn() }));

const executeSearchMock = vi.fn();

vi.mock("../plugin/search", () => ({
  executeSearch: (...args: unknown[]) => executeSearchMock(...args),
}));

beforeEach(() => {
  executeSearchMock.mockReset();
});

import { registerSearchTool } from "./tool";

function makeCtx(credential: unknown) {
  const added: unknown[] = [];
  return {
    ctx: {
      tool: {
        transform: vi.fn(async (callback: (editor: { add: (tool: unknown) => void }) => void) => {
          callback({ add: (tool: unknown) => void added.push(tool) });
        }),
      },
      integration: {
        connection: {
          active: vi.fn(async () => (credential ? { id: "conn" } : undefined)),
          resolve: vi.fn(async () => credential),
        },
      },
    },
    added,
  };
}

const FRESH_CREDENTIAL = {
  type: "oauth",
  methodID: "antigravity-oauth",
  refresh: "rt|proj",
  access: "ya29.test",
  expires: Date.now() + 3600_000,
};

describe("registerSearchTool", () => {
  it("registers google_search with a JSON-schema input", async () => {
    const { ctx, added } = makeCtx(FRESH_CREDENTIAL);
    await registerSearchTool(ctx as never);
    expect(added).toHaveLength(1);
    const tool = added[0] as { name: string; input: { required: string[] } };
    expect(tool.name).toBe("google_search");
    expect(tool.input.required).toEqual(["query"]);
  });

  it("executes search and wraps the markdown result", async () => {
    const { ctx, added } = makeCtx(FRESH_CREDENTIAL);
    await registerSearchTool(ctx as never);
    executeSearchMock.mockResolvedValue("## Results\nhello");
    const tool = added[0] as {
      execute: (input: unknown, context: unknown) => Promise<{ content: string }>;
    };
    const result = await tool.execute({ query: "test" }, { signal: undefined });
    expect(executeSearchMock).toHaveBeenCalledWith(
      { query: "test", urls: undefined, thinking: true },
      "ya29.test",
      "proj",
      undefined,
    );
    expect(result).toEqual({ content: "## Results\nhello" });
  });

  it("returns an auth error without a connection", async () => {
    const { ctx, added } = makeCtx(null);
    await registerSearchTool(ctx as never);
    const tool = added[0] as {
      execute: (input: unknown, context: unknown) => Promise<{ content: string }>;
    };
    const result = await tool.execute({ query: "test" }, { signal: undefined });
    expect(result.content).toMatch(/Not authenticated/);
    expect(executeSearchMock).not.toHaveBeenCalled();
  });
});
