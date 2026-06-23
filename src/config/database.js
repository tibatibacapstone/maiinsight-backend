import mysql from "mysql2";
import { env } from "./env.js";

export const pool = env.databaseUrl
  ? mysql.createPool(env.databaseUrl)
  : null;

export const checkDatabaseConnection = async () => {
  if (!pool) {
    return {
      ok: false,
      message: "DATABASE_URL is not configured",
    };
  }

  const [rows] = await pool.query("SELECT 1 AS ok");

  return {
    ok: rows[0]?.ok === 1,
    message: "Database connection is healthy",
  };
};
