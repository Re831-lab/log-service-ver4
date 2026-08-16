import { db } from "./index.js";
import { sql } from "drizzle-orm";

const RETENTION_DAYS = process.env.RETENTION_DAYS
  ? parseInt(process.env.RETENTION_DAYS)
  : 30;

export async function runRetentionMaintenance(): Promise<void> {
  try {
    await db.execute(sql`SELECT create_logs_partition(CURRENT_DATE)`);
    await db.execute(sql`SELECT create_logs_partition(CURRENT_DATE + 1)`);

    const result = await db.execute(
      sql`SELECT * FROM drop_old_log_partitions(${RETENTION_DAYS})`
    );

    if (result.rows.length > 0) {
      console.log(
        `Retention: dropped ${result.rows.length} old partition(s):`,
        result.rows.map((r: any) => r.dropped_partition).join(", ")
      );
    }

    // log_rollups isn't partitioned -- at one row per (minute, service, level) it stays
    // tiny (thousands of rows, not millions) even across the full retention window, so a
    // plain DELETE is cheap and doesn't need the DROP TABLE treatment `logs` gets.
    await db.execute(
      sql`DELETE FROM log_rollups WHERE bucket_start < NOW() - (${RETENTION_DAYS} || ' days')::interval`
    );
  } catch (error) {
    console.error("Retention maintenance failed:", error);
  }
}

export function startRetentionScheduler(): void {
  const intervalMs = 60 * 60 * 1000;
  setInterval(runRetentionMaintenance, intervalMs);
  console.log(
    `Retention scheduler started (runs every hour, retention: ${RETENTION_DAYS} days).`
  );
}