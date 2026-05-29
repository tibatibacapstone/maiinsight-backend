import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash("Password123!", 10);

  const users = [
    { email: "admin@maiin.com", name: "Admin User", role: "admin" },
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

  await prisma.notification.upsert({
    where: { id: 1 },
    update: {
      title: "Admin campaign ready",
      message: "Your admin dashboard is ready. A new campaign is Waiting for review.",
      role: "admin",
    },
    create: {
      title: "Admin campaign ready",
      message: "Your admin dashboard is ready. A new campaign is Waiting for review.",
      role: "admin",
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
  await prisma.user.deleteMany({
  where: {
    email: "marketing@maiin.com",
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
