import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../../services/auth.service';
import type { AuthPayload, UserRole } from '../../shared/types';

declare global {
  namespace Express {
    interface Request {
      auth: AuthPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ success: false, error: 'Missing authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    req.auth = verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

export function requireTenant(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth.tenant_id) {
    res.status(400).json({ success: false, error: 'No tenant context' });
    return;
  }
  next();
}
