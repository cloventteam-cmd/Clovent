import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.isDev ? 'debug' : 'info',
  transport: config.isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
  base: { service: 'clovent-backend' },
  redact: ['password', 'password_hash', 'refresh_token', 'authorization'],
});
