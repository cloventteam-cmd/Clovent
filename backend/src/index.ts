import 'dotenv/config';
import { createServer } from './api/server';
import { startAllWorkers } from './workers/index';
import { config } from './shared/config';
import { logger } from './shared/logger';
import { healthCheck, pool } from './db/client';
import { redisConnection, probeRedis } from './workers/queue';
import { eventBus } from './events/bus';
import { verifyPipelineWiring } from './events/pipeline';
import { flushMetricsToDB } from './observability/event-metrics';
import { flushUsageToDB } from './billing/usage-tracker';
import { trackError } from './observability/error-tracker';
import { migrate } from './db/migrate';

async function bootstrap(): Promise<void> {
  logger.info({ env: config.env, pid: process.pid, node: process.version }, 'CLOVENT booting...');

  // ── Database schema ─────────────────────────────────────────────────────────
  await migrate();

  // ── Database ─────────────────────────────────────────────────────────────────
  const dbOk = await healthCheck();
  if (!dbOk) {
    logger.fatal('Database connection failed — aborting startup');
    process.exit(1);
  }
  logger.info('Database: connected');

  // ── Redis (optional, falls back to in-memory queue mode) ─────────────────────
  const redisOk = await probeRedis();

  if (redisOk) {
    try {
      const IORedis = (await import('ioredis')).default;
      const pubClient = new IORedis(config.redis.url, {
        maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: true,
      });
      const subClient = new IORedis(config.redis.url, {
        maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: true,
      });
      await Promise.all([pubClient.connect(), subClient.connect()]);
      eventBus.connectRedis(pubClient, subClient);
      logger.info('EventBus: Redis pub/sub bridge active');
    } catch (err) {
      logger.warn({ err }, 'EventBus: pub/sub setup failed — local bus only');
    }
  } else {
    logger.warn('EventBus: using in-memory bus (single-process mode)');
  }

  // ── Reset circuit breakers (clear state from any pre-boot errors) ─────────────
  const { dbBreaker: db, redisBreaker: rd } = await import('./shared/circuit-breaker');
  db.reset(); rd.reset();

  // ── Real-time broadcaster (must wire AFTER pipeline handlers) ────────────────
  const { eventBroadcaster } = await import('./realtime/broadcaster');
  eventBroadcaster.wire();

  // ── Pipeline wiring ───────────────────────────────────────────────────────────
  verifyPipelineWiring();

  // ── Workers ───────────────────────────────────────────────────────────────────
  startAllWorkers();

  // ── Schedulers ────────────────────────────────────────────────────────────────
  if (process.env.RUN_SCHEDULER !== 'false') {
    await import('./jobs/scheduler');
    logger.info('Job scheduler: started');
  }

  // ── Metrics + usage flush (every 60s, non-blocking) ──────────────────────────
  const metricsInterval = setInterval(async () => {
    try {
      await Promise.all([flushMetricsToDB(), flushUsageToDB()]);
    } catch (err) { logger.error({ err }, 'Metrics flush error'); }
  }, 60_000);
  metricsInterval.unref(); // don't keep process alive just for this

  // ── Health snapshot (every 60s) ───────────────────────────────────────────────
  const healthInterval = setInterval(async () => {
    try {
      const [dbStatus, queueStats] = await Promise.all([
        healthCheck().catch(() => false),
        import('./workers/queue').then(q => q.getQueueStats()).catch(() => ({})),
      ]);
      const redisStatus = redisOk;
      const status = dbStatus ? 'healthy' : 'degraded';

      await import('./db/client').then(({ query }) =>
        query(
          `INSERT INTO health_snapshots (status, db_ok, redis_ok, worker_ok, queues, metrics)
           VALUES ($1,$2,$3,true,$4,'{}')`,
          [status, dbStatus, redisStatus, JSON.stringify(queueStats)],
        ).catch(() => {}),
      );
    } catch { /* non-fatal */ }
  }, 60_000);
  healthInterval.unref();

  // ── HTTP server ────────────────────────────────────────────────────────────────
  const app = createServer();
  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, mode: redisOk ? 'bullmq' : 'in-memory' },
      'CLOVENT API listening',
    );
  });

  // ── Graceful shutdown ──────────────────────────────────────────────────────────
  let shutdownInProgress = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;

    logger.info({ signal }, 'Graceful shutdown: initiated');

    // Stop accepting new connections
    server.close();

    // Give in-flight requests 10s to complete
    const forceKill = setTimeout(() => {
      logger.error('Graceful shutdown: timeout — forcing exit');
      process.exit(1);
    }, 10_000);
    forceKill.unref();

    try {
      // Flush pending metrics before exit
      await flushMetricsToDB().catch(() => {});

      // Stop DB pool
      await pool.end().catch(() => {});

      // Disconnect Redis
      try { redisConnection.disconnect(); } catch { /* ignore */ }

      clearInterval(metricsInterval);
      clearInterval(healthInterval);

      logger.info({ signal }, 'Graceful shutdown: complete');
      clearTimeout(forceKill);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Graceful shutdown: error');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  process.on('uncaughtException', async (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    await trackError(err, {}, 'system').catch(() => {});
    await shutdown('uncaughtException');
  });

  process.on('unhandledRejection', async (reason) => {
    logger.error({ reason }, 'Unhandled rejection');
    await trackError(reason as Error, {}, 'system').catch(() => {});
  });
}

bootstrap().catch(async (err) => {
  logger.fatal({ err }, 'Bootstrap failed');
  await trackError(err, {}, 'system').catch(() => {});
  process.exit(1);
});
