import { prisma } from "../config/prisma.js"
import { createNotificationsForRoles } from "./notification.service.js"

export const saveDownloadRecordAndNotifyManagement = async ({
  fileName,
  fileData,
  contentType = "text/csv; charset=utf-8",
  fileSizeBytes,
  req,
}) => {
  try {
    const userId = req?.user?.userId ?? 0
    let userName = req?.user?.email || "A user"

    if (userId) {
      try {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          select: { name: true, email: true },
        })
        userName = user?.name || user?.email || userName
      } catch {
        /* non-critical */
      }
    }

    const record = await prisma.downloadRecord.create({
      data: {
        fileName,
        contentType,
        fileData,
        fileSizeBytes:
          fileSizeBytes != null && fileSizeBytes > 0
            ? fileSizeBytes
            : Buffer.byteLength(fileData, "utf8"),
        downloadedById: userId,
        downloadedByName: userName,
      },
    })

    await createNotificationsForRoles(prisma, ["management"], {
      title: `${userName} downloaded ${fileName}`,
      message: `${userName} downloaded ${fileName}. Open the notification to view the file.`,
      downloadRecordId: record.id,
    })

    return record
  } catch (error) {
    return null
  }
}
