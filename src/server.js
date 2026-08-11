import cron from "node-cron";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { checkTokens } from "./services/tokenMonitor.service.js";

const server = app.listen(env.port, "0.0.0.0", () => {
  console.log(`MaiinSight API is running on port ${env.port}`);

  try {
    cron.schedule("0 6,18 * * *", () => {
      console.log("[tokenMonitor] Running scheduled token check...");
      checkTokens().catch((err) =>
        console.error("[tokenMonitor] Cron job failed:", err)
      );
    });
    console.log("[tokenMonitor] Cron scheduled: twice daily at 06:00 and 18:00");
  } catch (err) {
    console.warn("[tokenMonitor] Failed to schedule cron:", err);
  }
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