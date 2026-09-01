/**
 * Nextcloud connection configuration.
 *
 * Resolution order:
 *   1. Environment variables NEXTCLOUD_URL, NEXTCLOUD_USERNAME, NEXTCLOUD_APP_PASSWORD
 *      (NEXTCLOUD_USER / NEXTCLOUD_PASSWORD also accepted).
 *   2. JSON file pointed to by the NEXTCLOUD_CONFIG environment variable.
 *   3. ~/.pi/agent/nextcloud.json (created by the /nextcloud-setup command).
 *
 * The password must be an app password if the server uses 2FA
 * (Settings -> Security -> Devices & sessions -> Create new app password).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface NextcloudConfig {
  baseUrl: string;
  username: string;
  password: string;
}

const LEGACY_ENV_KEYS: ReadonlyArray<readonly [string, keyof NextcloudConfig]> = [
  ["NEXTCLOUD_URL", "baseUrl"],
  ["NEXTCLOUD_USERNAME", "username"],
  ["NEXTCLOUD_USER", "username"],
  ["NEXTCLOUD_APP_PASSWORD", "password"],
  ["NEXTCLOUD_PASSWORD", "password"],
];

export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (!url) throw new Error("Nextcloud URL is empty");
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  // Keep any path prefix (e.g. https://host/nextcloud) but strip trailing slash
  // and redundant file anchors.
  url = url.replace(/\/+$/, "");
  url = url.replace(/\/(index\.php|remote\.php|ocs\/v[12]\.php)$/, "");
  return url;
}

function envConfig(): NextcloudConfig | null {
  const values: Partial<Record<keyof NextcloudConfig, string>> = {};
  for (const [key, field] of LEGACY_ENV_KEYS) {
    const v = process.env[key];
    if (v && !values[field]) values[field] = v;
  }
  if (values.baseUrl && values.username && values.password) {
    return {
      baseUrl: normalizeBaseUrl(values.baseUrl),
      username: values.username,
      password: values.password,
    };
  }
  return null;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".pi", "agent", "nextcloud.json");
}

function configPaths(): string[] {
  const paths: string[] = [];
  const envPath = process.env.NEXTCLOUD_CONFIG;
  if (envPath) paths.push(envPath);
  paths.push(defaultConfigPath());
  return paths;
}

function parseConfigFile(path: string): NextcloudConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : typeof raw.server === "string" ? raw.server : "";
  const username = typeof raw.username === "string" ? raw.username : typeof raw.user === "string" ? raw.user : "";
  const password = typeof raw.password === "string" ? raw.password : "";
  if (!baseUrl || !username || !password) {
    throw new Error(`Config file ${path} must contain "baseUrl", "username" and "password"`);
  }
  return { baseUrl: normalizeBaseUrl(baseUrl), username, password };
}

export interface LoadedConfig {
  config: NextcloudConfig;
  source: string;
}

export function loadConfig(): LoadedConfig | null {
  const fromEnv = envConfig();
  if (fromEnv) return { config: fromEnv, source: "environment" };

  for (const path of configPaths()) {
    if (existsSync(path)) {
      try {
        return { config: parseConfigFile(path), source: path };
      } catch (err) {
        throw new Error(`Failed to read Nextcloud config ${path}: ${(err as Error).message}`);
      }
    }
  }
  return null;
}

export function configMissingHint(): string {
  return [
    "Nextcloud connection is not configured.",
    "Run /nextcloud-setup in the Pi session, or create",
    `${defaultConfigPath()} with: {"baseUrl": "https://cloud.example.com", "username": "user", "password": "app-password"},`,
    "or export NEXTCLOUD_URL / NEXTCLOUD_USERNAME / NEXTCLOUD_APP_PASSWORD.",
  ].join(" ");
}

export function saveConfig(config: NextcloudConfig): string {
  const path = process.env.NEXTCLOUD_CONFIG || defaultConfigPath();
  const normalized: NextcloudConfig = {
    baseUrl: normalizeBaseUrl(config.baseUrl),
    username: config.username.trim(),
    password: config.password,
  };
  mkdirSync(dirname(path), { recursive: true });
  // Restrict permissions — the file contains an app password.
  writeFileSync(path, JSON.stringify(normalized, null, 2) + "\n", { mode: 0o600 });
  try {
    statSync(path);
  } catch {
    /* ignore */
  }
  return path;
}