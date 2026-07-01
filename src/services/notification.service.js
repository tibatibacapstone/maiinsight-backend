export const createNotificationsForRoles = async (
  prismaClient,
  roles,
  { title, message }
) => {
  const uniqueRoles = [...new Set((roles || []).filter(Boolean))]

  if (!uniqueRoles.length || !title || !message) {
    return { count: 0 }
  }

  return prismaClient.notification.createMany({
    data: uniqueRoles.map((role) => ({
      role,
      title,
      message,
    })),
  })
}
