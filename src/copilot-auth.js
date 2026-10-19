import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { CredentialUnavailableError } from "./auth.js";

// This is the same unofficial device flow used by copilot-proxy-api v0.10.32.
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const defaultCopilotTokenFile = () => join(homedir(), ".local", "share", "codexproxy", "github_token");
export const copilotClientHeaders = {
  "editor-version": "vscode/1.110.0",
  "editor-plugin-version": "copilot-chat/0.53.0",
  "user-agent": "GitHubCopilotChat/0.53.0",
  "x-github-api-version": "2025-04-01"
};

export async function readCopilotCredential(path) {
  const info = await stat(path);
  if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Copilot credential file must be a private regular file (chmod 600)");
  }
  const token = (await readFile(path, "utf8")).trim();
  if (!token || /\s/.test(token)) throw new Error("Copilot credential file is empty or invalid");
  return token;
}

export async function saveCopilotCredential(path, token) {
  if (typeof token !== "string" || !token || /\s/.test(token)) throw new Error("Invalid GitHub credential");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(token);
    await file.close();
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await file.close();
    await unlink(temporary).catch(cleanup => { if (cleanup.code !== "ENOENT") throw cleanup; });
    throw error;
  }
}

async function githubJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, {
    ...options,
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", "content-type": "application/json", ...options.headers }
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`GitHub authentication request failed (HTTP ${response.status})`);
    error.code = `http_${response.status}`;
    throw error;
  }
  return response.json();
}

export async function loginCopilot({ tokenFile = defaultCopilotTokenFile(), fetchImpl = fetch,
  announce = console.log, wait = sleep, now = Date.now } = {}) {
  const device = await githubJson("https://github.com/login/device/code", {
    method: "POST", body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" })
  }, fetchImpl);
  if (typeof device.device_code !== "string" || typeof device.user_code !== "string" ||
      typeof device.verification_uri !== "string" || !device.verification_uri.startsWith("https://github.com/") ||
      !Number.isFinite(device.expires_in) || device.expires_in <= 0 ||
      !Number.isFinite(device.interval) || device.interval < 0) {
    throw new Error("GitHub returned an invalid device authorization response");
  }
  announce(`Open ${device.verification_uri} and enter ${device.user_code}`);
  const deadline = now() + device.expires_in * 1000;
  let interval = Math.max(1, device.interval) * 1000;
  while (now() < deadline) {
    await wait(interval);
    if (now() >= deadline) break;
    const result = await githubJson("https://github.com/login/oauth/access_token", {
      method: "POST",
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code" })
    }, fetchImpl);
    if (result.access_token) {
      await saveCopilotCredential(tokenFile, result.access_token);
      announce("Copilot login saved. No token was printed.");
      return;
    }
    if (result.error === "slow_down") interval += 5000;
    else if (result.error !== "authorization_pending") throw new Error("GitHub login denied or expired; run npm run copilot:login again");
  }
  throw new Error("GitHub device login expired; run npm run copilot:login again");
}

export class CopilotTokenManager {
  constructor({ tokenFile = defaultCopilotTokenFile(), fetchImpl = fetch, now = Date.now, logger = console } = {}) {
    Object.assign(this, { tokenFile, fetchImpl, now, logger });
    this.cached = null;
    this.inflight = null;
  }

  async getAccessToken({ staleToken } = {}) {
    if (this.cached && ((staleToken && staleToken !== this.cached.token) ||
        (!staleToken && this.cached.expiresAt - this.now() > 60_000))) return this.cached.token;
    if (!this.inflight) this.inflight = this.refresh().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async refresh() {
    const started = this.now();
    try {
      const credential = await readCopilotCredential(this.tokenFile);
      const result = await githubJson("https://api.github.com/copilot_internal/v2/token", {
        headers: { ...copilotClientHeaders, authorization: `token ${credential}` }
      }, this.fetchImpl);
      if (typeof result.token !== "string" || !result.token || /\s/.test(result.token) ||
          !Number.isFinite(result.expires_at) || result.expires_at * 1000 <= this.now()) {
        throw new Error("Copilot returned an invalid or expired token");
      }
      this.cached = { token: result.token, expiresAt: result.expires_at * 1000 };
      this.logger.info?.({ event: "auth.refreshed", provider: "github-copilot",
        duration_ms: this.now() - started, expires_at: new Date(this.cached.expiresAt).toISOString() }, "auth.refreshed");
      return result.token;
    } catch (error) {
      this.logger.error?.({ event: "auth.failed", provider: "github-copilot",
        code: /^http_\d+$/.test(error.code) ? error.code : "credential_unavailable" }, "auth.failed");
      throw new CredentialUnavailableError(
        "Copilot login unavailable; check the private credential file or run npm run copilot:login", error);
    }
  }
}
