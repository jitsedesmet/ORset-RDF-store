import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from './public/webserver';

export default async function globalSetup(): Promise<void> {
  // Restore test.nq to a known clean state before the test suite runs
  const backupPath = join(__dirname, 'public', 'test-backup.nq');
  const testPath = join(__dirname, 'public', 'test.nq');
  try {
    await copyFile(backupPath, testPath);
  } catch {
    throw new Error(`Failed to restore test.nq from backup (${backupPath}). Ensure test-backup.nq exists.`);
  }

  const server = await startServer(3000);
  (<any> globalThis).__WEBSERVER__ = server;
}
