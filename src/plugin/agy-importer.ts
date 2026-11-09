import { existsSync, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ANTIGRAVITY_CLIENT_ID,
  ANTIGRAVITY_CLIENT_SECRET,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  getAntigravityHeaders,
} from "../constants";
import { fetchProjectID, type AntigravityTokenExchangeResult } from "../antigravity/oauth";
import { formatRefreshParts } from "./auth";
import { createLogger } from "./logger";

const log = createLogger("agy-importer");

export interface AgyStoredTokenPayload {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  expiry?: string;
}

export interface AgyStoredToken {
  auth_method?: string;
  token?: AgyStoredTokenPayload;
}

/**
 * Known token storage paths for Antigravity CLI and JetSki standalone components.
 */
export function getAgyTokenPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
    join(home, ".gemini", "jetski-standalone-oauth-token"),
  ];
}

/**
 * Locate the first existing Antigravity CLI token file.
 */
export function findAgyTokenPath(): string | null {
  for (const p of getAgyTokenPaths()) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Check if an Antigravity CLI token file exists on the current system.
 */
export function hasAgyToken(): boolean {
  return findAgyTokenPath() !== null;
}

/**
 * Read and parse an Antigravity CLI token file safely.
 */
export async function readAgyTokenRaw(filePath?: string): Promise<AgyStoredToken | null> {
  const targetPath = filePath ?? findAgyTokenPath();
  if (!targetPath || !existsSync(targetPath)) {
    return null;
  }

  try {
    const raw = await fs.readFile(targetPath, "utf8");
    const parsed = JSON.parse(raw) as AgyStoredToken;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch (error) {
    log.warn("Failed to read or parse Antigravity CLI token file", {
      path: targetPath,
      error: String(error),
    });
  }

  return null;
}

/**
 * Refresh an OAuth token using Antigravity client credentials.
 */
export async function refreshAgyToken(
  refreshToken: string,
): Promise<{ access_token: string; expires_in: number; refresh_token?: string } | null> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: ANTIGRAVITY_CLIENT_ID,
        client_secret: ANTIGRAVITY_CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      log.warn("Failed to refresh Antigravity CLI token", { status: response.status });
      return null;
    }

    return (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };
  } catch (error) {
    log.warn("Error refreshing Antigravity CLI token", { error: String(error) });
    return null;
  }
}

export interface ImportAgyTokenOptions {
  tokenPath?: string;
  projectId?: string;
}

/**
 * Import authentication credentials from an existing Antigravity CLI session.
 */
export async function importAgyToken(
  options: ImportAgyTokenOptions = {},
): Promise<AntigravityTokenExchangeResult> {
  const tokenData = await readAgyTokenRaw(options.tokenPath);
  if (!tokenData || !tokenData.token) {
    return {
      type: "failed",
      error: "No valid Antigravity CLI token found in ~/.gemini",
    };
  }

  const { token } = tokenData;
  const refreshToken = token.refresh_token;
  if (!refreshToken) {
    return {
      type: "failed",
      error: "Antigravity CLI token file does not contain a refresh token",
    };
  }

  let accessToken = token.access_token ?? "";
  let expires = token.expiry ? Date.parse(token.expiry) : 0;

  // Refresh if token is expired or within 60s of expiring
  const isExpired = !accessToken || isNaN(expires) || Date.now() + 60_000 >= expires;
  if (isExpired) {
    log.info("Antigravity CLI access token expired, refreshing...");
    const refreshed = await refreshAgyToken(refreshToken);
    if (!refreshed) {
      return {
        type: "failed",
        error: "Failed to refresh Antigravity CLI access token",
      };
    }
    accessToken = refreshed.access_token;
    expires = Date.now() + refreshed.expires_in * 1000;
  }

  // Retrieve user email
  let email: string | undefined;
  try {
    const userinfoResp = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": getAntigravityHeaders()["User-Agent"],
      },
    });
    if (userinfoResp.ok) {
      const data = (await userinfoResp.json()) as { email?: string };
      email = data.email;
    }
  } catch (e) {
    log.warn("Failed to fetch user email during agy token import", { error: String(e) });
  }

  // Resolve managed project context
  let managedProject = "";
  try {
    managedProject = await fetchProjectID(accessToken);
  } catch (e) {
    log.warn("Failed to resolve project ID during agy token import", { error: String(e) });
  }

  if (!managedProject) {
    managedProject = ANTIGRAVITY_DEFAULT_PROJECT_ID;
  }

  const effectiveProject = options.projectId || managedProject;

  return {
    type: "success",
    refresh: formatRefreshParts({
      refreshToken,
      projectId: options.projectId || "",
      managedProjectId: managedProject,
    }),
    access: accessToken,
    expires,
    email,
    projectId: effectiveProject,
  };
}

