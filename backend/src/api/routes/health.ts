/**
 * Detailed Health Routes
 *
 * GET /health           — overall system health
 * GET /health/db        — postgres pool + query latency
 * GET /health/redis     — redis ping + queue depths
 * GET /health/workers   — per-queue stats + failure counts
 * GET /health/metrics   — real-time event throughput
 * GET /health/errors    — unresolved error events
 */
import { Router } from 'express';
import { pool, query, queryOne } from '../../db/client';
import { redisConnection, getQueueStats } from '../../workers/queue';
import { getRealtimeStats, getCounterSnapshot } from '../../observability/event-metrics';
import { getActiveErrors } from '../../observability/error-tracker';
import { dbBreaker, redisBreaker } from '../../shared/circuit-breaker';
import { logger } from '../../shared/logger';

const router = Router();

// Cached state (updated on each check, so /health is always fast)
let lastDbOk = true;
let lastRedisOk = true;

// ── GET /health ───────────────────────────────────────────────────────────────
router.get('/', async (_req, res) => {
  const [dbOk, queues] = await Promise.allSettled([
    checkDb(),
    getQueueStats(),
  ]);

  const db = dbOk.status === 'fulfilled' ? dbOk.value : false;
  const q  = queues.status === 'fulfilled' ? queues.value : {};

  const status = db ? 'healthy' : 'degraded';

  res.status(db ? 200 : 503).json({
    status,
    version: process.env.npm_package_version ?? '1.0.0',
    uptime_s: Math.floor(process.uptime()),
    db: db ? 'connected' : 'unreachable',
    redis: lastRedisOk ? 'connected' : 'unreachable',
    workers: Object.keys(q).length > 0 ? 'running' : 'unknown',
    circuit_breakers: {
      postgres: dbBreaker.getState(),
      redis: redisBreaker.getState(),
    },
    queue_mode: Object.values(q)[0]?.mode ?? 'unknown',
    timestamp: new Date().toISOString(),
  });
});

// ── GET /health/db ────────────────────────────────────────────────────────────
router.get('/db', async (_req, res) => {
  const start = Date.now();
  try {
    const row = await queryOne<{ now: string; pg_version: string; max_conn: string; cur_conn: string }>(
      `SELECT NOW()::text as now,
              version() as pg_version,
              (SELECT setting FROM pg_settings WHERE name = 'max_connections') as max_conn,
              (SELECT count(*) FROM pg_stat_activity WHERE state = 'active')::text as cur_conn`,
    );

    const poolStats = (pool as any)._clients?.length !== undefined
      ? { total: (pool as any)._clients.length, idle: (pool as any).idleCount, waiting: (pool as any).waitingCount }
      : { total: '?', idle: '?', waiting: '?' };

    lastDbOk = true;
    res.json({
      status: 'connected',
      latency_ms: Date.now() - start,
      server_time: row?.now,
      pg_version: row?.pg_version?.split(' ')[0],
      connections: {
        max: parseInt(row?.max_conn ?? '100', 10),
        active: parseInt(row?.cur_conn ?? '0', 10),
        pool: poolStats,
      },
      circuit_breaker: dbBreaker.getState(),
    });
  } catch (err) {
    lastDbOk = false;
    logger.error({ err }, 'Health: DB check failed');
    res.status(503).json({
      status: 'unreachable',
      latency_ms: Date.now() - start,
      error: (err as Error).message,
      circuit_breaker: dbBreaker.getState(),
    });
  }
});

// ── GET /health/redis ─────────────────────────────────────────────────────────
router.get('/redis', async (_req, res) => {
  const start = Date.now();
  try {
    const pong = await redisConnection.ping();
    const info = await redisConnection.info('server').catch(() => '');
    const versionMatch = info.match(/redis_version:([\d.]+)/);
    const memMatch = info.match(/used_memory_human:([^\r\n]+)/);

    lastRedisOk = true;
    res.json({
      status: 'connected',
      ping: pong,
      latency_ms: Date.now() - start,
      redis_version: versionMatch?.[1],
      used_memory: memMatch?.[1]?.trim(),
      circuit_breaker: redisBreaker.getState(),
    });
  } catch (err) {
    lastRedisOk = false;
    res.status(503).json({
      status: 'unreachable',
      latency_ms: Date.now() - start,
      error: (err as Error).message,
      circuit_breaker: redisBreaker.getState(),
    });
  }
});

// ── GET /health/workers ───────────────────────────────────────────────────────
router.get('/workers', async (_req, res) => {
  try {
    const queues = await getQueueStats();

    // Failed job counts from DB
    const failRow = await queryOne<{ total: string; unresolved: string }>(
      `SELECT COUNT(*)::text AS total,
              COUNT(*) FILTER (WHERE reprocessed = false)::text AS unresolved
       FROM job_failures`,
    ).catch(() => null);

    // Recent job failures (last 5)
    const { queryMany } = await import('../../db/client');
    const recentFails = await queryMany(
      `SELECT queue_name, job_name, error, failed_at
       FROM job_failures WHERE reprocessed = false
       ORDER BY failed_at DESC LIMIT 5`,
    ).catch(() => []);

    res.json({
      status: Object.values(queues).every(q => q.failed === 0) ? 'healthy' : 'degraded',
      queues,
      failures: {
        total: parseInt(failRow?.total ?? '0', 10),
        unresolved: parseInt(failRow?.unresolved ?? '0', 10),
        recent: recentFails,
      },
      mode: Object.values(queues)[0]?.mode ?? 'unknown',
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: (err as Error).message });
  }
});

// ── GET /health/metrics ───────────────────────────────────────────────────────
router.get('/metrics', (_req, res) => {
  const realtime = getRealtimeStats();
  const pending = getCounterSnapshot();

  res.json({
    realtime,
    pending_flush: pending.length,
    timestamp: new Date().toISOString(),
  });
});

// ── GET /health/errors ────────────────────────────────────────────────────────
router.get('/errors', async (_req, res) => {
  try {
    const errors = await getActiveErrors(20);
    res.json({ count: errors.length, errors });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Helper
async function checkDb(): Promise<boolean> {
  try { await query('SELECT 1'); lastDbOk = true; return true; }
  catch { lastDbOk = false; return false; }
}

export default router;
