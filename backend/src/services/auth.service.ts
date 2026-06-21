import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { query, queryOne } from '../db/client';
import { config } from '../shared/config';
import { slugify } from '../shared/utils';
import type { UUID, AuthPayload, UserRole } from '../shared/types';

export interface LoginResult {
  user: Record<string, unknown>;
  access_token: string;
  refresh_token: string;
}

// Cast the JWT expiresIn string (e.g. "15m") through unknown to satisfy jsonwebtoken's StringValue type
function jwtOpts(expiresIn: string): SignOptions {
  return { expiresIn: expiresIn as unknown as SignOptions['expiresIn'] };
}

export async function registerOrganization(params: {
  org_name: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
}): Promise<LoginResult> {
  const slug = slugify(params.org_name);
  const existing = await queryOne('SELECT id FROM organizations WHERE slug = $1', [slug]);
  if (existing) throw new Error(`Organization slug "${slug}" already taken`);

  const passwordHash = await bcrypt.hash(params.password, 12);

  const org = await queryOne<{ id: UUID }>(
    `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id`,
    [params.org_name, slug],
  );
  if (!org) throw new Error('Failed to create organization');

  const user = await queryOne<Record<string, unknown>>(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, email_verified)
     VALUES ($1,$2,$3,$4,$5,'owner',true) RETURNING *`,
    [org.id, params.email.toLowerCase(), passwordHash, params.first_name, params.last_name],
  );
  if (!user) throw new Error('Failed to create user');

  return generateTokensAndReturn(user);
}

export async function login(tenantId: UUID, email: string, password: string): Promise<LoginResult> {
  const user = await queryOne<Record<string, unknown>>(
    'SELECT * FROM users WHERE tenant_id = $1 AND email = $2 AND is_active = true',
    [tenantId, email.toLowerCase()],
  );
  if (!user) throw new Error('Invalid credentials');

  const valid = await bcrypt.compare(password, String(user.password_hash ?? ''));
  if (!valid) throw new Error('Invalid credentials');

  await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
  return generateTokensAndReturn(user);
}

export async function refreshTokens(refreshToken: string): Promise<LoginResult> {
  let payload: AuthPayload;
  try {
    payload = jwt.verify(refreshToken, config.jwt.refreshSecret) as AuthPayload;
  } catch {
    throw new Error('Invalid refresh token');
  }

  const user = await queryOne<Record<string, unknown>>(
    'SELECT * FROM users WHERE id = $1 AND is_active = true',
    [payload.user_id],
  );
  if (!user || user.refresh_token !== refreshToken) throw new Error('Refresh token revoked');

  return generateTokensAndReturn(user);
}

export async function revokeRefreshToken(userId: UUID): Promise<void> {
  await query('UPDATE users SET refresh_token = NULL WHERE id = $1', [userId]);
}

async function generateTokensAndReturn(user: Record<string, unknown>): Promise<LoginResult> {
  const payload: AuthPayload = {
    user_id: user.id as UUID,
    tenant_id: user.tenant_id as UUID,
    role: user.role as UserRole,
    email: user.email as string,
  };

  const access_token = jwt.sign(payload, config.jwt.secret, jwtOpts(config.jwt.expiresIn));
  const refresh_token = jwt.sign(payload, config.jwt.refreshSecret, jwtOpts(config.jwt.refreshExpiresIn));

  await query('UPDATE users SET refresh_token = $1 WHERE id = $2', [refresh_token, user.id]);

  const { password_hash: _ph, refresh_token: _rt, ...safeUser } = user;
  return { user: safeUser, access_token, refresh_token };
}

export function verifyAccessToken(token: string): AuthPayload {
  return jwt.verify(token, config.jwt.secret) as AuthPayload;
}
