import express from "express";
import "dotenv/config";
import { logsRouter } from "./routes/logs.js";
import { db, healthPool } from "./db/index.js";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { runRetentionMaintenance, startRetentionScheduler } from "./db/retention.js";
import { env } from "./config/env.js";

const app = express();
const PORT = env.port;

app.use(express.json());

let isReady = false;

app.get("/health", async (req, res) => {
  if (!isReady) {
    return res.status(503).json({ status: "not ready" });
  }
  try {

    await healthPool.query("SELECT 1");
    return res.status(200).json({ status: "ok" });
  } catch {
    return res.status(503).json({ status: "unhealthy" });
  }
});

app.use(logsRouter);

app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (err instanceof SyntaxError && "body" in err) {
      return res.status(400).json({ error: "malformed JSON in request body" });
    }

    console.error(err);
    res.status(500).json({ error: "internal server error" });
  }
);


process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

async function start() {
  try {
    console.log("Applying database migrations...");
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
    console.log("Migrations applied successfully.");

    await runRetentionMaintenance();
    startRetentionScheduler();

    await db.execute(sql`SELECT 1`);
    isReady = true;
    console.log("Database connection established.");

    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

start();
