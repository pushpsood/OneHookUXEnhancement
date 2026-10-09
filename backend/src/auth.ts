import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { NextFunction, Request, Response } from 'express';
import type { ContextualFeatureConfig } from './contextConfig';
import type { AuthenticatedPrincipal } from './contextTypes';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedPrincipal;
    }
  }
}

export function extractPermissions(payload: JWTPayload): Set<string> {
  const permissions = new Set<string>();
  const scope = payload.scope ?? payload.scp;
  if (typeof scope === 'string') {
    for (const permission of scope.split(/\s+/).filter(Boolean)) permissions.add(permission);
  }
  const roles = payload.roles;
  if (Array.isArray(roles)) {
    for (const role of roles) if (typeof role === 'string' && role.length > 0) permissions.add(role);
  } else if (typeof roles === 'string' && roles.length > 0) {
    permissions.add(roles);
  }
  return permissions;
}

export function resolveSessionTier(
  payload: JWTPayload,
  claimName: string,
  configuredTiers: Readonly<Record<string, unknown>>,
): string | undefined {
  const claim = payload[claimName];
  const candidates = typeof claim === 'string'
    ? [claim]
    : Array.isArray(claim) ? claim.filter((value): value is string => typeof value === 'string') : [];
  for (const candidate of candidates) {
    const normalized = candidate.trim().toLowerCase();
    if (normalized.length > 0 && Object.prototype.hasOwnProperty.call(configuredTiers, normalized)) {
      return normalized;
    }
  }
  return undefined;
}

export function createJwtAuthenticator(config: ContextualFeatureConfig, audience = config.authAudience) {
  const jwks = createRemoteJWKSet(new URL(config.authJwksUri));

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'AUTH_REQUIRED' });
      return;
    }

    try {
      const token = authorization.slice('Bearer '.length);
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.authIssuer,
        audience,
        algorithms: config.authAlgorithms,
        clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 256) {
        throw new Error('Missing stable subject');
      }
      const tier = resolveSessionTier(payload, config.sessionTierClaim, config.sessionTierPolicies);
      req.auth = {
        subject: payload.sub,
        permissions: extractPermissions(payload),
        ...(tier ? { tier } : {}),
      };
      next();
    } catch {
      res.status(401).json({ error: 'INVALID_ACCESS_TOKEN' });
    }
  };
}

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth?.permissions.has(permission)) {
      res.status(403).json({ error: 'INSUFFICIENT_PERMISSION' });
      return;
    }
    next();
  };
}
