import { readFileSync } from 'fs';
import path from 'path';
import { pool } from './client';
import { logger } from '../shared/logger';

async function migrate() {
  logger.info('Running migrations...');

  const migrationFile = path.join(__dirname, 'migrations', '001_initial.sql');
  const sql = readFileSync(migrationFile, 'utf-8');

  const client = await pool.connect();
  try {
    await client.query(sql);
    logger.info('Migration completed successfully');
  } catch (err) {
    logger.error({ err }, 'Migration failed');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(() => process.exit(1));
