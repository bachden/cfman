import type { Pool, PoolClient } from "pg";
import { config } from "../config.js";
import { pool } from "./database.js";

type QueryExecutor = Pick<Pool | PoolClient, "query">;

const PUBLIC_BASE_URL_KEY = "public_base_url";
const BRANDING_KEY = "branding";

export const BRAND_ICONS = ["cloud-cog", "cloud", "cable", "globe", "shield-check", "server", "zap"] as const;
export type BrandIcon = (typeof BRAND_ICONS)[number];

export type Branding = { icon: BrandIcon; title: string; subtitle: string };

const DEFAULT_BRANDING: Branding = {
  icon: "cloud-cog",
  title: "CFMan",
  subtitle: "Easy Cloudflare tunnels"
};

export async function getBranding(executor: QueryExecutor = pool): Promise<Branding> {
  const result = await executor.query("SELECT value FROM app_settings WHERE key = $1", [BRANDING_KEY]);
  if (!result.rows[0]) return DEFAULT_BRANDING;
  try {
    return { ...DEFAULT_BRANDING, ...JSON.parse(result.rows[0].value as string) };
  } catch {
    return DEFAULT_BRANDING;
  }
}

export async function setBranding(branding: Branding, userId: string, executor: QueryExecutor = pool): Promise<Branding> {
  await executor.query(
    `INSERT INTO app_settings(key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [BRANDING_KEY, JSON.stringify(branding), userId]
  );
  return branding;
}

export function normalizePublicBaseUrl(value: string): string {
  const candidate = value.trim().includes("://") ? value.trim() : `https://${value.trim()}`;
  const url = new URL(candidate);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Public base URL must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Public base URL cannot include credentials");
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("Public base URL cannot include a path, query, or fragment");
  return url.origin;
}

export async function getPublicBaseUrlSetting(executor: QueryExecutor = pool): Promise<{ publicBaseUrl: string; configured: boolean }> {
  const result = await executor.query("SELECT value FROM app_settings WHERE key = $1", [PUBLIC_BASE_URL_KEY]);
  return {
    publicBaseUrl: normalizePublicBaseUrl(result.rows[0]?.value ?? config.PUBLIC_BASE_URL),
    configured: Boolean(result.rows[0])
  };
}

export async function getPublicBaseUrl(executor: QueryExecutor = pool): Promise<string> {
  return (await getPublicBaseUrlSetting(executor)).publicBaseUrl;
}

export async function setPublicBaseUrl(value: string, userId: string, executor: QueryExecutor = pool): Promise<string> {
  const normalized = normalizePublicBaseUrl(value);
  await executor.query(
    `INSERT INTO app_settings(key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [PUBLIC_BASE_URL_KEY, normalized, userId]
  );
  return normalized;
}
