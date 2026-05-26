import pg from "pg";
import { env } from "./env.js";

const { Pool } = pg;

export const pool = env.databaseUrl
  ? new Pool({
      connectionString: env.databaseUrl,
    })
  : null;

export const checkDatabaseConnection = async () => {
  if (!pool) {
    return {
      ok: false,
      message: "DATABASE_URL is not configured",
    };
  }

  const result = await pool.query("select 1 as ok");

  return {
    ok: result.rows[0]?.ok === 1,
    message: "Database connection is healthy",
  };
};
