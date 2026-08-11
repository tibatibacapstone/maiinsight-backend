export const buildNotificationReadInclude = (userId) => ({
  reads: { where: { userId }, select: { readAt: true }, take: 1 },
})

export const buildUnreadNotificationWhere = (role, userId) => ({
  role,
  reads: { none: { userId } },
})

export const buildNotificationReceiptKey = (notificationId, userId) => ({
  notificationId_userId: { notificationId, userId },
})

export const buildNotificationReceiptRows = (notifications, userId) =>
  notifications.map(({ id }) => ({ notificationId: id, userId }))
