import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const users = await prisma.user.findMany({
  select: {
    id: true,
    email: true,
    name: true,
    role: true,
  },
  orderBy: {
    id: "asc",
  },
});

console.table(users);

await prisma.$disconnect();
