import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import { z } from "zod";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const booleanFromString = z.preprocess((value) => {
  if (typeof value === "string") return value.toLowerCase() === "true";
  return value;
}, z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  SERVER_HOST: z.string().default("127.0.0.1"),
  SERVER_PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().optional(),
  DATABASE_URL: z.string().min(1),
  DATABASE_SCHEMA: z.string().regex(/^[a-z_][a-z0-9_]*$/).default("public"),
  ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  CLOUDFLARED_VERSION: z.string().min(1),
  CFMAN_WAF_ALLOWED_IPS: z.string().default(""),
  ALLOW_MOCK_ACCOUNTS: booleanFromString.default(false),
  // File storage. Which driver is in use is the only part of this the webapp
  // ever sees: the base path, bucket, and credentials stay on the server, so
  // moving the same path tree from a local directory to a bucket is invisible
  // to every caller that addresses a file by path.
  FILE_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  // Absolute directory on the machine running cfman. Every storage path is
  // resolved against it; dropping a file into it directly makes the file
  // appear in the file manager.
  FILE_STORAGE_LOCAL_PATH: z.string().default(fileURLToPath(new URL("../../../storage", import.meta.url))),
  FILE_STORAGE_MAX_UPLOAD_MB: z.coerce.number().int().positive().max(20_480).default(512),
  // Where an enrolled machine's own uploads land: <prefix>/<tenant>/<tunnel>.
  // A machine can read the whole store but only write inside its own folder.
  FILE_STORAGE_TUNNEL_UPLOAD_PREFIX: z.string().default("uploads"),
  // S3-compatible endpoint, bucket, and credentials. For Cloudflare R2 use
  // https://<account-id>.r2.cloudflarestorage.com with region "auto" and
  // path-style addressing, which are this schema's defaults.
  FILE_STORAGE_S3_ENDPOINT: z.string().url().optional(),
  FILE_STORAGE_S3_REGION: z.string().min(1).default("auto"),
  FILE_STORAGE_S3_BUCKET: z.string().min(1).optional(),
  FILE_STORAGE_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  FILE_STORAGE_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  FILE_STORAGE_S3_SESSION_TOKEN: z.string().min(1).optional(),
  // Keys are written under this prefix inside the bucket, so one bucket can
  // hold more than one cfman deployment.
  FILE_STORAGE_S3_PREFIX: z.string().default(""),
  // R2 and MinIO both address a bucket in the path, not as a subdomain, so
  // path style is the default; set this to false only for an endpoint that
  // requires virtual-hosted addressing.
  FILE_STORAGE_S3_FORCE_PATH_STYLE: booleanFromString.default(true)
});

const parsed = schema.parse(process.env);

export const config = {
  ...parsed,
  PUBLIC_BASE_URL: parsed.PUBLIC_BASE_URL ?? `http://${parsed.SERVER_HOST}:${parsed.SERVER_PORT}`
};
