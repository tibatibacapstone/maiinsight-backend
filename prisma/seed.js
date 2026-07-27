import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("Password123!", 10);

  const users = [
    { email: "operational@maiin.com", name: "Marketing Operational User", role: "operational" },
    { email: "management@maiin.com", name: "Management User", role: "management" },
    { email: "support@maiin.com", name: "IT Support", role: "it_support" },
  ];

  for (const user of users) {
    await prisma.user.upsert({
      where: { email: user.email },
      update: { name: user.name, role: user.role, password: passwordHash },
      create: {
        email: user.email,
        name: user.name,
        role: user.role,
        password: passwordHash,
      },
    });
  }

  const appSettings = {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
    GEMINI_MODEL: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    GEMINI_ENABLED: process.env.GEMINI_API_KEY ? "true" : "false",
    META_IG_USER_ID: process.env.META_IG_USER_ID || "",
    META_ACCESS_TOKEN: process.env.META_ACCESS_TOKEN || "",
    META_GRAPH_VERSION: process.env.META_GRAPH_VERSION || "v25.0",
    META_ENABLED:
      process.env.META_IG_USER_ID && process.env.META_ACCESS_TOKEN ? "true" : "false",
  };

  for (const [key, value] of Object.entries(appSettings)) {
    await prisma.appSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  await prisma.notification.upsert({
    where: { id: 1 },
    update: {
      title: "Marketing campaign ready",
      message: "Your marketing dashboard is ready. A new campaign is waiting for review.",
      role: "operational",
    },
    create: {
      title: "Marketing campaign ready",
      message: "Your marketing dashboard is ready. A new campaign is waiting for review.",
      role: "operational",
    },
  });

  await prisma.notification.upsert({
    where: { id: 2 },
    update: {
      title: "Status report generated",
      message: "Quarterly status report is now available.",
      role: "management",
    },
    create: {
      title: "Status report generated",
      message: "Quarterly status report is now available.",
      role: "management",
    },
  });

  await prisma.notification.upsert({
    where: { id: 3 },
    update: {
      title: "Server maintenance scheduled",
      message: "IT support will monitor the system tomorrow.",
      role: "it_support",
    },
    create: {
      title: "Server maintenance scheduled",
      message: "IT support will monitor the system tomorrow.",
      role: "it_support",
    },
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
