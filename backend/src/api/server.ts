import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import path from 'node:path';

import authRoutes from './routes/auth';
import contactRoutes from './routes/contacts';
import dealRoutes from './routes/deals';
import importRoutes from './routes/imports';
import activityRoutes from './routes/activities';
import opportunityRoutes from './routes/opportunities';
import campaignRoutes from './routes/campaigns';
import aiRoutes from './routes/ai';
import notificationRoutes from './routes/notifications';
import crmRoutes from './routes/crm';
import healthRoutes from './routes/health';
import streamRoutes from './routes/stream';
import predictionRoutes from './routes/predictions';
import billingRoutes, { stripeWebhookRouter } from './routes/billing';
import adminRoutes from './routes/admin';

import { errorHandler, notFound } from './middleware/error';
import { requestLogger, tenantRateLimiter } from '../observability/request-logger';
import { trackError } from '../observability/error-tracker';
import { auditLog } from '../billing/middleware/audit-logger';
import { trackUsage } from '../billing/usage-tracker';
import { config } from '../shared/config';
import { logger } from '../shared/logger';

export function createServer() {
  const app = express();

  // ── Security ────────────────────────────────────────────────────────────────
  app.use(helmet());
  app.use(cors({
    origin: config.isDev ? '*' : process.env.ALLOWED_ORIGINS?.split(',') ?? [],
    credentials: true,
    exposedHeaders: ['X-Correlation-ID'],
  }));
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ── Observability: request logging + correlation IDs ─────────────────────────
  app.use(requestLogger);

  // ── Audit logging (all mutating API calls) ────────────────────────────────────
  app.use('/api/', auditLog);

  // ── Stripe webhooks (raw body needed for signature — mount BEFORE json parser) ─
  app.use('/webhooks', stripeWebhookRouter);

  // ── Global rate limit (per IP, burst protection) ─────────────────────────────
  app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1_000,
    keyGenerator: (req) => (req as any).auth?.tenant_id ?? req.ip ?? 'unknown',
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests' },
  }));

  // ── Per-tenant rate limit (post-auth routes) ──────────────────────────────────
  // Applied after global limit; keyed by tenant_id from JWT.
  // 300 req/min per tenant = ~5 req/s sustained, 600 burst in first 30s.
  app.use('/api/', tenantRateLimiter(300, 60_000));

  // ── Auth endpoint stricter limit ──────────────────────────────────────────────
  app.use('/api/auth/login', rateLimit({
    windowMs: 15 * 60 * 1000, max: 20,
    message: { success: false, error: 'Too many login attempts' },
  }));

  // ── Health routes (no auth, no rate limit) ────────────────────────────────────
  app.use('/health', healthRoutes);

  // ── API routes ────────────────────────────────────────────────────────────────
  app.use('/api/auth',          authRoutes);
  app.use('/api/contacts',      contactRoutes);
  app.use('/api/deals',         dealRoutes);
  app.use('/api/imports',       importRoutes);
  app.use('/api/activities',    activityRoutes);
  app.use('/api/opportunities', opportunityRoutes);
  app.use('/api/campaigns',     campaignRoutes);
  app.use('/api/ai',            aiRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/crm',           crmRoutes);
  app.use('/api/stream',        streamRoutes);
  app.use('/api/predictions',   predictionRoutes);
  app.use('/api/billing',       billingRoutes);
  app.use('/api/admin',         adminRoutes);

  app.use(express.static(path.resolve(__dirname, '../../public')));

  // ── Error handling ────────────────────────────────────────────────────────────
  app.use(notFound);

  // Error handler that also tracks to error_events table
  app.use(async (err: Error, req: any, res: any, next: any) => {
    await trackError(err, { path: req.path, method: req.method }, 'api');
    errorHandler(err, req, res, next);
  });

  return app;
}
