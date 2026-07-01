import { app } from "./app.js";
import { env } from "./config/env.js";

const server = app.listen(env.port, () => {
  console.log(`MaiinSight API is running on http://localhost:${env.port}`);
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(
      `Port ${env.port} is already in use. Stop the existing process or change PORT before starting the API again.`,
    );
    process.exit(1);
  }

  console.error("Failed to start MaiinSight API.", error);
  process.exit(1);
});

const shutdown = async (signal) => {
  console.log(`${signal} received. Shutting down API...`);

  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
