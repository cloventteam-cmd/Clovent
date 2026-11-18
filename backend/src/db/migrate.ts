import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pool, transaction } from './client';
import { logger } from '../shared/logger';

async function migrate() {
  const directory = path.join(__dirname, 'migrations');
  const files = (await readdir(directory))
    .filter(file => /^\d+_.+\.sql$/.test(file))
    .sort();
  if (files.length === 0) throw new Error('Clovent database migrations are missing.');

  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('clovent_terminal_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS clovent_terminal_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const history = await client.query<{ filename: string }>(
      'SELECT filename FROM clovent_terminal_migrations',
    );
    const applied = new Set(history.rows.map(row => row.filename));

    if (applied.size === 0) {
      const existing = await client.query<{ initialized: boolean }>(
        "SELECT to_regclass('organizations') IS NOT NULL AS initialized",
      );
      if (existing.rows[0].initialized) {
        throw new Error('Clovent tables already exist without migration history. Verify the existing schema before recording its applied migrations.');
      }
    }

    for (const filename of files) {
      if (applied.has(filename)) continue;

      logger.info({ filename }, 'Applying Clovent database migration');
      await client.query(await readFile(path.join(directory, filename), 'utf8'));
      await client.query(
        'INSERT INTO clovent_terminal_migrations (filename) VALUES ($1)',
        [filename],
      );
    }
  });
}

migrate()
  .catch(err => {
    logger.error({ err }, 'Clovent database migration failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
