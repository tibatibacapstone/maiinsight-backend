import { app } from "./app.js";
import { env } from "./config/env.js";
import { pool } from "./config/database.js";

const server = app.listen(env.port, () => {
  console.log(`MaiinSight API is running on http://localhost:${env.port}`);
});

const shutdown = async (signal) => {
  console.log(`${signal} received. Shutting down API...`);

  server.close(async () => {
    if (pool) {
      await pool.end();
    }

    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
