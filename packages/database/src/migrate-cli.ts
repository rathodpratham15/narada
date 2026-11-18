import { ConfigError, loadDatabaseConfig } from '@narada/config';
import { createDatabase } from './client';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const handle = createDatabase(config.DATABASE_URL, { max: 1 });
  try {
    await runMigrations(handle.db);
    console.log('Migrations applied.');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message);
  } else {
    console.error('Migration failed:', error);
  }
  process.exit(1);
});
