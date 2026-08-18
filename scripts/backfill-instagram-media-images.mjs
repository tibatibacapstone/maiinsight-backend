// One-time (and re-runnable) backfill: downloads and caches the image bytes
// for every InstagramMedia row that doesn't have one yet, so displayed
// photos stop depending on Meta's temporary, expiring media_url/thumbnail_url
// links. Safe to re-run — cacheMediaImage skips rows that already have a
// cachedImageData value.
import { PrismaClient } from "@prisma/client"
import { cacheMediaImagesForBatch } from "../src/services/metaMedia.service.js"

const prisma = new PrismaClient()
const CONCURRENCY = 4

async function main() {
  const pending = await prisma.instagramMedia.findMany({
    where: { cachedImageData: null },
    select: {
      id: true,
      igMediaId: true,
      mediaType: true,
      mediaUrl: true,
      thumbnailUrl: true,
      cachedImageData: true,
      postedAt: true,
    },
    orderBy: { postedAt: "desc" },
  })

  console.log(`=== Backfilling images for ${pending.length} Instagram media item(s) ===`)

  if (pending.length === 0) {
    console.log("Nothing to do.")
    await prisma.$disconnect()
    return
  }

  let done = 0
  const total = pending.length
  const chunkSize = 20

  for (let i = 0; i < pending.length; i += chunkSize) {
    const chunk = pending.slice(i, i + chunkSize)
    const cached = await cacheMediaImagesForBatch(chunk, {
      refetchFreshUrl: true,
      concurrency: CONCURRENCY,
    })
    done += chunk.length
    console.log(`  [${done}/${total}] processed this chunk, ${cached} newly cached`)
  }

  const stillMissing = await prisma.instagramMedia.count({ where: { cachedImageData: null } })
  console.log(`=== Done. ${stillMissing} media item(s) still without a cached image (deleted/unavailable on Instagram, or non-image content). ===`)

  await prisma.$disconnect()
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
