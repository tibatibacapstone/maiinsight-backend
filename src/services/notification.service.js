export const createNotificationsForRoles = async (
  prismaClient,
  roles,
  { title, message, downloadRecordId }
) => {
  const uniqueRoles = [...new Set((roles || []).filter(Boolean))]

  if (!uniqueRoles.length || !title || !message) {
    return { count: 0 }
  }

  const existingForRole = await prismaClient.notification.findMany({
    where: {
      title,
      read: false,
      role: { in: uniqueRoles },
      ...(downloadRecordId != null ? { downloadRecordId } : {}),
    },
    select: { role: true },
    distinct: ["role"],
  })

  const alreadyNotifiedRoles = new Set(existingForRole.map((item) => item.role))
  const rolesToNotify = uniqueRoles.filter((role) => !alreadyNotifiedRoles.has(role))

  if (!rolesToNotify.length) {
    return { count: 0, skipped: true }
  }

  return prismaClient.notification.createMany({
    data: rolesToNotify.map((role) => ({
      role,
      title,
      message,
      ...(downloadRecordId != null ? { downloadRecordId } : {}),
    })),
  })
}
