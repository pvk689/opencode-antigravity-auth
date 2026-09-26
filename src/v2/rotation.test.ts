import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@opencode-ai/plugin", () => ({ tool: vi.fn() }));

import { AccountManager } from "../plugin/accounts";
import type { AccountStorageV4 } from "../plugin/storage";
import { DEFAULT_CONFIG } from "../plugin/config";
import { setV2AccountManager, setV2Config } from "./auth";
import { handleHttpRequest, handleHttpResponse } from "./request";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash:streamGenerateContent";

function quota429(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "Quota exhausted, reset after 1s",
        details: [
          { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1s" },
        ],
      },
    }),
    { status: 429, headers: { "Content-Type": "application/json" } },
  );
}

describe("V2 request pipeline (mocked fetch)", () => {
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let manager: AccountManager;

  beforeEach(() => {
    fetchCalls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const urlString = String(url);
        fetchCalls.push({ url: urlString, init });
        if (urlString.includes("loadCodeAssist")) {
          return new Response(JSON.stringify({ cloudaicompanionProject: "test-proj" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (urlString.includes("oauth2.googleapis.com")) {
          return new Response("unexpected refresh", { status: 500 });
        }
        // Antigravity content endpoint: terminal non-retryable error.
        return new Response(JSON.stringify({ error: { message: "bad request" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    setV2Config({ ...DEFAULT_CONFIG });
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [{ refreshToken: "rt", projectId: "p1", addedAt: 1, lastUsed: 0 }],
      activeIndex: 0,
    };
    manager = new AccountManager(
      { type: "oauth", refresh: "rt|p1", access: "ya29.test", expires: Date.now() + 3600_000 },
      stored,
    );
    setV2AccountManager(manager);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setV2AccountManager(null);
  });

  it("rewrites the provider request to Antigravity and rotates quota on 429", async () => {
    const event = {
      request: new Request(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }),
      model: { providerID: "google", id: "antigravity-gemini-3.8-flash" },
    };

    await handleHttpRequest(event);
    expect(event.request.url).toContain("cloudcode-pa.googleapis.com");
    expect(event.request.headers.get("authorization")).toBe("Bearer ya29.test");

    const responseEvent = { request: event.request, response: quota429() };
    await handleHttpResponse(responseEvent);
    const rotationCalls = fetchCalls.filter((c) => c.url.includes("streamGenerateContent"));
    // Core attempt is provided directly; exactly one rotation fetch expected.
    expect(rotationCalls).toHaveLength(1);
    // Single account exhausted Antigravity -> fell back to Gemini CLI (PROD).
    expect(rotationCalls[0]?.url).toContain("cloudcode-pa.googleapis.com");
    // Terminal error passes through the response transform.
    expect(responseEvent.response.status).toBe(400);
    // The Antigravity quota bucket was locked with a future reset time.
    const resetTimes = manager.getAccounts()[0]?.rateLimitResetTimes ?? {};
    const keys = Object.keys(resetTimes);
    expect(keys.some((k) => k.includes("antigravity"))).toBe(true);
    const resetValues = Object.values(resetTimes).filter((v): v is number => typeof v === "number");
    expect(resetValues.length).toBeGreaterThan(0);
    expect(Math.min(...resetValues)).toBeGreaterThan(Date.now());
  }, 30000);
});
