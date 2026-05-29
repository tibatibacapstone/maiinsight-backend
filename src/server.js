import { app } from "./app.js";
import { env } from "./config/env.js";

const server = app.listen(env.port, () => {
  console.log(`MaiinSight API is running on http://localhost:${env.port}`);
});

const shutdown = async (signal) => {
  console.log(`${signal} received. Shutting down API...`);

  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);