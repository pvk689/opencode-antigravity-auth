import { describe, expect, it } from "vitest";
import type { AntigravityTokenExchangeResult } from "../antigravity/oauth";
import { credentialEmail, toOAuthCredential } from "./credential";
import { V2_OAUTH_METHOD_ID } from "./constants";

const success: Extract<AntigravityTokenExchangeResult, { type: "success" }> = {
  type: "success",
  refresh: "rt|proj",
  access: "ya29.test",
  expires: 1790423443897,
  email: "user@example.com",
  projectId: "proj",
};

describe("toOAuthCredential", () => {
  it("maps a success result to a V2 OAuth credential", () => {
    expect(toOAuthCredential(success)).toEqual({
      type: "oauth",
      methodID: V2_OAUTH_METHOD_ID,
      refresh: "rt|proj",
      access: "ya29.test",
      expires: 1790423443897,
      metadata: { email: "user@example.com", projectId: "proj" },
    });
  });

  it("throws on exchange failure", () => {
    expect(() =>
      toOAuthCredential({ type: "failed", error: "bad code" }),
    ).toThrow(/bad code/);
  });
});

describe("credentialEmail", () => {
  it("reads the stored email", () => {
    expect(credentialEmail(toOAuthCredential(success))).toBe("user@example.com");
  });

  it("returns undefined when missing", () => {
    const cred = toOAuthCredential({ ...success, email: undefined });
    expect(credentialEmail(cred)).toBeUndefined();
  });
});
