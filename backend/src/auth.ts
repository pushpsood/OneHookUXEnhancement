import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { NextFunction, Request, Response } from 'express';
import type { SubscriptionTier } from 'onehook-api-client';
import { onUnknownSubscriptionTier, resolveSubscriptionTier } from 'onehook-api-client/membership';
import { normalizeTier, type ContextualFeatureConfig } from './contextConfig';
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

// A verified token carrying a tier that is not Must / Super / Infinity is treated as Must (no persisted
// AI session) and logged as an error so a developer investigates where the value came from.
onUnknownSubscriptionTier((raw) => {
  console.error(new Error(`UnknownSubscriptionTier: token tier '${raw.slice(0, 64)}' treated as Must`));
});

export function resolveSessionTier(
  payload: JWTPayload,
  claimName: string,
  configuredTiers: Readonly<Partial<Record<SubscriptionTier, unknown>>>,
): SubscriptionTier | undefined {
  const claim = payload[claimName];
  if (typeof claim === 'string') {
    // A single tier claim (custom:subscriptionTier): unknown → Must (reported), which has no policy.
    const tier = resolveSubscriptionTier(claim);
    return Object.prototype.hasOwnProperty.call(configuredTiers, tier) ? tier : undefined;
  }
  // A group list (cognito:groups): non-tier groups are normal, so they are skipped silently.
  const candidates = Array.isArray(claim) ? claim.filter((value): value is string => typeof value === 'string') : [];
  for (const candidate of candidates) {
    const tier = normalizeTier(candidate);
    if (tier && Object.prototype.hasOwnProperty.call(configuredTiers, tier)) {
      return tier;
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
