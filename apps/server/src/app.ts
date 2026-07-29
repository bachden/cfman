import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { LogController } from "fastify";
import { ZodError } from "zod";
import { config } from "./config.js";
import { getPublicBaseUrl } from "./lib/app-settings.js";
import { accountRoutes } from "./routes/accounts.js";
import { authRoutes } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { enrollmentRoutes } from "./routes/enrollment.js";
import { mcpRoutes } from "./routes/mcp.js";
import { settingsRoutes } from "./routes/settings.js";
import { scriptRoutes } from "./routes/scripts.js";
import { tunnelRoutes } from "./routes/tunnels.js";

export async function buildApp() {
  const app = Fastify({
    logger: config.NODE_ENV !== "test" ? { level: config.NODE_ENV === "development" ? "info" : "warn" } : false,
    trustProxy: true,
    logController: new LogController({ disableRequestLogging: true })
  });

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // Registered before routes and the static-file fallback below: a
  // fastify-static + setNotFoundHandler registration that runs after
  // setErrorHandler silently prevents it from firing for prior routes.
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Validation failed",
        fields: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const pgError = error as Error & { code?: string; constraint?: string; statusCode?: number };
    if (pgError.code === "23505") {
      return reply.code(409).send({ error: "A record with the same unique value already exists" });
    }
    const statusCode = typeof pgError.statusCode === "number" ? pgError.statusCode : 500;
    const message = error instanceof Error ? error.message : "Unknown error";
    return reply.code(statusCode).send({ error: statusCode >= 500 ? "Internal server error" : message });
  });

  app.addHook("onRequest", async (request, reply) => {
    const hostname = request.hostname.toLowerCase();
    if (["localhost", "127.0.0.1", "::1"].includes(hostname)) return;
    if (request.url === "/health" || request.url.startsWith("/api/auth/") || request.url.startsWith("/api/settings")) return;
    if (!request.url.startsWith("/api/") && !request.url.startsWith("/e/") && !request.url.startsWith("/mcp")) return;
    const publicHostname = new URL(await getPublicBaseUrl()).hostname.toLowerCase();
    if (hostname !== publicHostname) {
      return reply.code(421).send({ error: "Host is not allowed" });
    }
  });

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });

  app.get("/health", async () => ({ status: "ok" }));
  await authRoutes(app);
  await accountRoutes(app);
  await tunnelRoutes(app);
  await scriptRoutes(app);
  await enrollmentRoutes(app);
  await dashboardRoutes(app);
  await settingsRoutes(app);
  await mcpRoutes(app);

  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (config.NODE_ENV === "production") {
    try {
      await access(join(webRoot, "index.html"));
      await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
      app.setNotFoundHandler(async (request, reply) => {
        if (request.url.startsWith("/api/") || request.url.startsWith("/e/") || request.url.startsWith("/mcp")) {
          return reply.code(404).send({ error: "Not found" });
        }
        return reply.type("text/html").sendFile("index.html");
      });
    } catch {
      app.log.warn("Web build not found; API-only mode enabled");
    }
  }

  return app;
}
