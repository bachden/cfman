import { timingSafeEqual } from "node:crypto";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { writeAudit } from "../lib/audit.js";
import { requireAuth } from "../lib/auth.js";
import { pool } from "../lib/database.js";
import { decryptSecret } from "../lib/security.js";
import { fileStorageInfo, fileStorageSettings, getMaxUploadBytes, tunnelUploadRootById } from "../lib/storage/index.js";
import {
  createFolder,
  listFolder,
  movePath,
  openFile,
  readFileInline,
  removePath,
  spoolUpload,
  statPath,
  writeFileInline,
  writeSpooledUpload
} from "../lib/storage/operations.js";
import { StorageError } from "../lib/storage/types.js";

const AGENT_TOKEN_HEADER = "x-cloudflare-man-agent-token";

const pathQuery = z.object({ path: z.string().max(2000).optional() });
const requiredPathQuery = z.object({ path: z.string().min(1).max(2000) });
const downloadQuery = z.object({ path: z.string().min(1).max(2000), download: z.coerce.boolean().optional() });
const deleteQuery = z.object({ path: z.string().min(1).max(2000), recursive: z.coerce.boolean().optional() });
const inlineReadQuery = z.object({ path: z.string().min(1).max(2000), encoding: z.enum(["utf8", "base64"]).default("utf8") });
const folderBody = z.object({ path: z.string().min(1).max(2000) });
const moveBody = z.object({ from: z.string().min(1).max(2000), to: z.string().min(1).max(2000) });
const inlineWriteBody = z.object({
  path: z.string().min(1).max(2000),
  content: z.string().max(12_000_000),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  contentType: z.string().trim().max(200).optional()
});
const tunnelParams = z.object({ tunnelId: z.string().uuid() });

// A file name can be anything the path rules allow, including characters no
// HTTP header can carry literally, so the plain filename is reduced to ASCII
// and the exact name is repeated in the RFC 5987 form.
function contentDisposition(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "'");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function sendFile(reply: FastifyReply, found: { stat: { name: string; size: number; contentType: string; modifiedAt: string | null }; stream: Readable }, inline: boolean) {
  reply.header("Content-Type", found.stat.contentType);
  reply.header("Content-Length", String(found.stat.size));
  reply.header("Content-Disposition", contentDisposition(found.stat.name, inline));
  reply.header("Cache-Control", "private, no-store");
  if (found.stat.modifiedAt) reply.header("Last-Modified", new Date(found.stat.modifiedAt).toUTCString());
  return reply.send(found.stream);
}

// Rejects an oversized upload on its declared length before a byte is spooled.
// spoolUpload still meters the stream, because Content-Length is the client's
// claim and a chunked body carries none at all.
function assertUploadSize(request: FastifyRequest, maxBytes: number): void {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new StorageError(`Upload exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MB limit`, 413);
  }
}

function requestContentType(request: FastifyRequest): string | undefined {
  const value = request.headers["content-type"];
  return typeof value === "string" ? value : undefined;
}

// The enrolled machine's credential is the command-agent token the installer
// already put on that machine, so a script does not need a second secret to
// reach the file store. The tunnel is named in the path because the token is
// stored encrypted rather than hashed and so cannot be looked up by value.
async function authenticateTunnelAgent(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const { tunnelId } = tunnelParams.parse(request.params);
  const presented = request.headers[AGENT_TOKEN_HEADER];
  const token = typeof presented === "string" ? presented : "";
  const stored = await pool.query("SELECT token_encrypted FROM tunnel_command_agents WHERE tunnel_id = $1", [tunnelId]);
  const expected = stored.rows[0]?.token_encrypted ? decryptSecret(stored.rows[0].token_encrypted as string) : null;
  const expectedBuffer = Buffer.from(expected ?? "", "utf8");
  const presentedBuffer = Buffer.from(token, "utf8");
  const matches = Boolean(expected)
    && expectedBuffer.length === presentedBuffer.length
    && timingSafeEqual(expectedBuffer, presentedBuffer);
  if (!matches) {
    await reply.code(401).send({ error: "Invalid agent credentials" });
    return null;
  }
  return tunnelId;
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  // Encapsulated so the catch-all body parser below applies to these routes
  // only: an upload arrives with the file's own content type and has to reach
  // the handler as an unread stream, while every other route in the app keeps
  // Fastify's default parsing.
  await app.register(async (instance) => {
    instance.addContentTypeParser("*", (_request, payload, done) => done(null, payload));

    instance.get("/api/files", { preHandler: requireAuth }, async (request) => {
      const query = pathQuery.parse(request.query);
      return { storage: await fileStorageSettings(), ...(await listFolder(query.path)) };
    });

    instance.get("/api/files/stat", { preHandler: requireAuth }, async (request) => {
      const query = pathQuery.parse(request.query);
      return { file: await statPath(query.path) };
    });

    instance.get("/api/files/content", { preHandler: requireAuth }, async (request, reply) => {
      const query = downloadQuery.parse(request.query);
      return sendFile(reply, await openFile(query.path), !query.download);
    });

    // Read into a JSON response rather than streamed, for MCP and anything
    // else that cannot consume a binary stream.
    instance.get("/api/files/data", { preHandler: requireAuth }, async (request) => {
      const query = inlineReadQuery.parse(request.query);
      return { file: await readFileInline(query.path, query.encoding) };
    });

    instance.put("/api/files/content", { preHandler: requireAuth }, async (request, reply) => {
      const query = requiredPathQuery.parse(request.query);
      const maxBytes = await getMaxUploadBytes();
      assertUploadSize(request, maxBytes);
      const upload = await spoolUpload(request.body as Readable, maxBytes);
      try {
        const file = await writeSpooledUpload(query.path, upload, { contentType: requestContentType(request) });
        await writeAudit({
          actorUserId: request.authUser!.id,
          action: "file_storage.file_written",
          entityType: "file",
          entityId: file.path,
          details: { driver: fileStorageInfo().driver, size: file.size, contentType: file.contentType, via: "web" },
          ipAddress: request.ip
        });
        return reply.code(201).send({ file });
      } finally {
        await upload.cleanup();
      }
    });

    instance.post("/api/files/data", { preHandler: requireAuth }, async (request, reply) => {
      const body = inlineWriteBody.parse(request.body);
      const file = await writeFileInline(body.path, body.content, { encoding: body.encoding, contentType: body.contentType });
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "file_storage.file_written",
        entityType: "file",
        entityId: file.path,
        details: { driver: fileStorageInfo().driver, size: file.size, contentType: file.contentType, via: "api" },
        ipAddress: request.ip
      });
      return reply.code(201).send({ file });
    });

    instance.post("/api/files/folders", { preHandler: requireAuth }, async (request, reply) => {
      const body = folderBody.parse(request.body);
      const folder = await createFolder(body.path);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "file_storage.folder_created",
        entityType: "folder",
        entityId: folder.path,
        details: { driver: fileStorageInfo().driver },
        ipAddress: request.ip
      });
      return reply.code(201).send(folder);
    });

    instance.post("/api/files/move", { preHandler: requireAuth }, async (request) => {
      const body = moveBody.parse(request.body);
      const moved = await movePath(body.from, body.to);
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "file_storage.path_moved",
        entityType: "file",
        entityId: moved.to,
        details: { driver: fileStorageInfo().driver, from: moved.from },
        ipAddress: request.ip
      });
      return moved;
    });

    instance.delete("/api/files", { preHandler: requireAuth }, async (request) => {
      const query = deleteQuery.parse(request.query);
      const removed = await removePath(query.path, { recursive: query.recursive ?? false });
      await writeAudit({
        actorUserId: request.authUser!.id,
        action: "file_storage.path_deleted",
        entityType: "file",
        entityId: removed.path,
        details: { driver: fileStorageInfo().driver, recursive: query.recursive ?? false },
        ipAddress: request.ip
      });
      return { success: true, ...removed };
    });

    // What an enrolled machine reaches. Reading spans the whole store, so one
    // artifact can be published once and pulled by every machine; writing is
    // confined to the tunnel's own upload folder, so a machine that is taken
    // over cannot overwrite another tunnel's files or a published artifact.
    instance.get("/api/public/tunnels/:tunnelId/files", {
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } }
    }, async (request, reply) => {
      const tunnelId = await authenticateTunnelAgent(request, reply);
      if (!tunnelId) return reply;
      const query = pathQuery.parse(request.query);
      return { uploadRoot: await tunnelUploadRootById(tunnelId), ...(await listFolder(query.path)) };
    });

    instance.get("/api/public/tunnels/:tunnelId/files/stat", {
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } }
    }, async (request, reply) => {
      const tunnelId = await authenticateTunnelAgent(request, reply);
      if (!tunnelId) return reply;
      const query = pathQuery.parse(request.query);
      return { uploadRoot: await tunnelUploadRootById(tunnelId), file: await statPath(query.path) };
    });

    instance.get("/api/public/tunnels/:tunnelId/files/content", {
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } }
    }, async (request, reply) => {
      const tunnelId = await authenticateTunnelAgent(request, reply);
      if (!tunnelId) return reply;
      const query = downloadQuery.parse(request.query);
      return sendFile(reply, await openFile(query.path), false);
    });

    instance.put("/api/public/tunnels/:tunnelId/files/content", {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
    }, async (request, reply) => {
      const tunnelId = await authenticateTunnelAgent(request, reply);
      if (!tunnelId) return reply;
      const query = requiredPathQuery.parse(request.query);
      const maxBytes = await getMaxUploadBytes();
      assertUploadSize(request, maxBytes);
      const writeRoot = await tunnelUploadRootById(tunnelId);
      const upload = await spoolUpload(request.body as Readable, maxBytes);
      try {
        const file = await writeSpooledUpload(query.path, upload, { contentType: requestContentType(request), writeRoot });
        await writeAudit({
          action: "file_storage.file_written",
          entityType: "file",
          entityId: file.path,
          details: { driver: fileStorageInfo().driver, size: file.size, contentType: file.contentType, via: "tunnel", tunnelId },
          ipAddress: request.ip
        });
        return reply.code(201).send({ file, uploadRoot: writeRoot });
      } finally {
        await upload.cleanup();
      }
    });

    instance.delete("/api/public/tunnels/:tunnelId/files/content", {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
    }, async (request, reply) => {
      const tunnelId = await authenticateTunnelAgent(request, reply);
      if (!tunnelId) return reply;
      const query = deleteQuery.parse(request.query);
      const writeRoot = await tunnelUploadRootById(tunnelId);
      const removed = await removePath(query.path, { recursive: query.recursive ?? false, writeRoot });
      await writeAudit({
        action: "file_storage.path_deleted",
        entityType: "file",
        entityId: removed.path,
        details: { driver: fileStorageInfo().driver, recursive: query.recursive ?? false, via: "tunnel", tunnelId },
        ipAddress: request.ip
      });
      return { success: true, ...removed, uploadRoot: writeRoot };
    });
  });
}
