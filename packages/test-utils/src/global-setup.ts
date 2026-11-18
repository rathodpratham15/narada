import { setupTestDatabase } from './index';

export default async function globalSetup(): Promise<void> {
  await setupTestDatabase();
}
