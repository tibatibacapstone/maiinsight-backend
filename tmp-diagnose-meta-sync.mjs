import { syncMetaRawToAnalytics } from './src/services/metaAnalytics.service.js';
import { prisma } from './src/config/prisma.js';

async function run() {
  try {
    const result = await syncMetaRawToAnalytics();
    console.log('RESULT', result);
  } catch (error) {
    console.error('ERROR', error instanceof Error ? error.message : error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
