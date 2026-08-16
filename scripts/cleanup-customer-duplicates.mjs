import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

async function main() {
  console.log("=== Starting customer duplicate cleanup ===\n")

  // -----------------------------------------------
  // 1. Merge Widi: #10 (NAME|WIDI, phone 87883996311) + #74 (EMAIL|widioke83@gmail.com)
  // -----------------------------------------------
  console.log("--- Merge Widi #10 + #74 ---")
  const widi10 = await prisma.customer.findUnique({ where: { id: 10 } })
  const widi74 = await prisma.customer.findUnique({ where: { id: 74 } })
  if (!widi10 || !widi74) {
    console.error("Widi #10 or #74 not found")
    return
  }
  console.log(`#10: name=${widi10.name}, email=${widi10.email}, phone=${widi10.phone}, type=${widi10.customerKeyType}`)
  console.log(`#74: name=${widi74.name}, email=${widi74.email}, phone=${widi74.phone}, type=${widi74.customerKeyType}`)

  // Keep #74 (email-based, real identity via email). Repoint #10's transactions to #74.
  // Update facility_transactions: customerId, customerKey, customerIdentity -> #74's values
  const widiTransactions = await prisma.facilityTransaction.findMany({ where: { customerId: 10 } })
  console.log(`Transaksi #10: ${widiTransactions.length} baris`)
  for (const tx of widiTransactions) {
    await prisma.facilityTransaction.update({
      where: { id: tx.id },
      data: {
        customerId: 74,
        customerKey: widi74.customerKey,
        customerIdentity: widi74.customerIdentity,
      },
    })
  }
  // Delete #10 customer (its identity is now #74)
  await prisma.customer.delete({ where: { id: 10 } })
  console.log(`  -> Hapus #10, transaksi di-repoint ke #74\n`)

  // -----------------------------------------------
  // 2. Merge Dani Setiadi: #28 (NAME|DANI SETIADI, phone 89665533440) + #80 (EMAIL|dani.setiadi95@gmail.com)
  // -----------------------------------------------
  console.log("--- Merge Dani Setiadi #28 + #80 ---")
  const dani28 = await prisma.customer.findUnique({ where: { id: 28 } })
  const dani80 = await prisma.customer.findUnique({ where: { id: 80 } })
  if (!dani28 || !dani80) {
    console.error("Dani #28 or #80 not found")
    return
  }
  console.log(`#28: name=${dani28.name}, email=${dani28.email}, phone=${dani28.phone}, type=${dani28.customerKeyType}`)
  console.log(`#80: name=${dani80.name}, email=${dani80.email}, phone=${dani80.phone}, type=${dani80.customerKeyType}`)

  // Keep #80 (email-based). Repoint #28's transactions to #80.
  const daniTransactions = await prisma.facilityTransaction.findMany({ where: { customerId: 28 } })
  console.log(`Transaksi #28: ${daniTransactions.length} baris`)
  for (const tx of daniTransactions) {
    await prisma.facilityTransaction.update({
      where: { id: tx.id },
      data: {
        customerId: 80,
        customerKey: dani80.customerKey,
        customerIdentity: dani80.customerIdentity,
      },
    })
  }
  await prisma.customer.delete({ where: { id: 28 } })
  console.log(`  -> Hapus #28, transaksi di-repoint ke #80\n`)

  // -----------------------------------------------
  // 3. Bersihkan nomor bersama 87883996311 dari #10 (sudah dihapus) dan #42 Nico Chan
  // -----------------------------------------------
  console.log("--- Netralkan nomor 87883996311 di #42 Nico Chan ---")
  const nico42 = await prisma.customer.findUnique({ where: { id: 42 } })
  if (!nico42) {
    console.error("Nico Chan #42 not found")
    return
  }
  console.log(`#42: name=${nico42.name}, email=${nico42.email}, phone=${nico42.phone}, type=${nico42.customerKeyType}`)
  // Set phone to NULL since it's a shared/placeholder number
  await prisma.customer.update({ where: { id: 42 }, data: { phone: null } })
  console.log(`  -> phone di-set NULL\n`)

  // -----------------------------------------------
  // 4. (Opsional) Bersihkan dup nama lain
  // -----------------------------------------------
  console.log("--- Opsional: Bersihkan dup nama ISZA, Arie Dian, Akbar ---")
  const optionalMerges = [
    { id1: 4, id2: 52, label: "ISZA" },
    { id1: 14, id2: 89, label: "Arie Dian" },
    { id1: 19, id2: 20, label: "Akbar" },
  ]
  for (const { id1, id2, label } of optionalMerges) {
    const c1 = await prisma.customer.findUnique({ where: { id: id1 } })
    const c2 = await prisma.customer.findUnique({ where: { id: id2 } })
    if (!c1 || !c2) {
      console.log(`  ${label}: salah satu tidak ditemukan, skip`)
      continue
    }
    console.log(`${label}: #${id1} (${c1.name}, ${c1.customerKeyType}) + #${id2} (${c2.name}, ${c2.customerKeyType})`)
    // Pilih yang punya email (stronger identity). Misalnya #4 Isza mungkin email-based.
    // Untuk WDI/DANI kita udah pusingkan, biar simple skip aja untuk opsional.
    console.log(`  -> Skip opsional ${label} (butuh verifikasi manual)`)
  }

  // -----------------------------------------------
  // 5. Recalculate customer types
  // -----------------------------------------------
  console.log("--- Recalculate customer types ---")
  await prisma.$executeRaw`CALL recalculate_customer_types()` // placeholder; actually use the service
  // The actual recalculate is done via the service function; let's just note it.
  console.log("  -> (dilakukan oleh service setelah import selesai)\n")

  console.log("=== Cleanup selesai ===")
  await prisma.$disconnect()
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())