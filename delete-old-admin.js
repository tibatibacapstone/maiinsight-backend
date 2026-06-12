import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

await prisma.user.deleteMany({
  where: {
    email: "admin@maiin.com",
  },
});

console.log("Old admin user deleted.");

await prisma.$disconnect();
