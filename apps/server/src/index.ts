import { buildApp } from "./app.js";
import { config } from "./config.js";
import { runMigrations, seedRootUser } from "./lib/database.js";
import { runStartupReconciliation, scheduleExpiredEnrollmentSweep } from "./lib/reconciliation.js";

await runMigrations();
await seedRootUser();
await runStartupReconciliation();
scheduleExpiredEnrollmentSweep();

const app = await buildApp();
await app.listen({ host: config.SERVER_HOST, port: config.SERVER_PORT });

const shutdown = async () => {
  await app.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
