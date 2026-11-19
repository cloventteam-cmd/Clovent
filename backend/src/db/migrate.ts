import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { pool } from './client';
import { logger } from '../shared/logger';

function findMigrationDirectory(): string {
  const candidates = [
    path.resolve(__dirname, 'migrations'),
    path.resolve(process.cwd(), 'backend/src/db/migrations'),
    path.resolve(process.cwd(), 'src/db/migrations'),
  ];
  const directory = candidates.find(candidate => {
    try { return readdirSync(candidate).some(file => /^\d+_.*\.sql$/.test(file)); }
    catch { return false; }
  });
  if (!directory) throw new Error('Could not locate Clovent SQL migrations');
  return directory;
}

export async function migrate(): Promise<void> {
  const directory = findMigrationDirectory();
  const files = readdirSync(directory).filter(file => /^\d+_.*\.sql$/.test(file)).sort();
  const client = await pool.connect();

  try {
    await client.query(`CREATE TABLE IF NOT EXISTS clovent_schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    for (const file of files) {
      const version = file.slice(0, file.indexOf('_'));
      const applied = await client.query('SELECT 1 FROM clovent_schema_migrations WHERE version = $1', [version]);
      if (applied.rowCount) continue;

      // Do not replay the original schema over an existing database that predates
      // migration tracking. Recognize a complete base schema and mark it applied.
      if (version === '001') {
        const core = await client.query(`SELECT COUNT(*)::int AS count FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [['organizations', 'users', 'contacts', 'deals']]);
        const count = Number(core.rows[0]?.count ?? 0);
        if (count > 0 && count < 4) {
          throw new Error('Clovent database has a partial base schema; refusing to replay initial tables automatically.');
        }
        if (count === 4) {
          await client.query('INSERT INTO clovent_schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [version]);
          logger.info({ migration: file }, 'Recognized existing Clovent base schema');
          continue;
        }
      }

      logger.info({ migration: file }, 'Applying Clovent database migration');
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(path.join(directory, file), 'utf8'));
        await client.query('INSERT INTO clovent_schema_migrations(version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

if (require.main === module) {
  migrate().then(() => pool.end()).catch(async err => {
    logger.error({ err }, 'Migration failed');
    await pool.end();
    process.exit(1);
  });
}
