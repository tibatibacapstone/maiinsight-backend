import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting MaiinSight database seed...");

  const isTidb = process.env.DATABASE_URL?.includes("tidbcloud.com");

  console.log(
    `Target database: ${isTidb ? "TiDB Cloud" : "Local/other database"}`,
  );

  const passwordHash = await bcrypt.hash("Password123!", 10);

  const users = [
    {
      email: "operational@maiin.com",
      name: "Marketing Operational User",
      role: "operational",
    },
    {
      email: "management@maiin.com",
      name: "Management User",
      role: "management",
    },
    {
      email: "support@maiin.com",
      name: "IT Support",
      role: "it_support",
    },
  ];

  for (const user of users) {
    const savedUser = await prisma.user.upsert({
      where: {
        email: user.email,
      },
      update: {
        name: user.name,
        role: user.role,
        password: passwordHash,
      },
      create: {
        email: user.email,
        name: user.name,
        role: user.role,
        password: passwordHash,
      },
    });

    console.log(`User seeded: ${savedUser.email}`);
  }

  const notifications = [
    {
      id: 1,
      title: "Marketing campaign ready",
      message:
        "Your marketing dashboard is ready. A new campaign is waiting for review.",
      role: "operational",
    },
    {
      id: 2,
      title: "Status report generated",
      message: "Quarterly status report is now available.",
      role: "management",
    },
    {
      id: 3,
      title: "Server maintenance scheduled",
      message: "IT support will monitor the system tomorrow.",
      role: "it_support",
    },
  ];

  for (const notification of notifications) {
    await prisma.notification.upsert({
      where: {
        id: notification.id,
      },
      update: {
        title: notification.title,
        message: notification.message,
        role: notification.role,
      },
      create: {
        id: notification.id,
        title: notification.title,
        message: notification.message,
        role: notification.role,
      },
    });

    console.log(`Notification seeded: ${notification.title}`);
  }

  const userCount = await prisma.user.count();
  const notificationCount = await prisma.notification.count();

  console.log("Seed completed successfully.");
  console.log(`Total users: ${userCount}`);
  console.log(`Total notifications: ${notificationCount}`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });