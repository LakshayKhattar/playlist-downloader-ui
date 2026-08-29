import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_HEADER = 'x-playlist-token';
const SAFE_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);
const AUTH_WINDOW_MS = 15 * 60_000;
const MAX_AUTH_FAILURES = 10;

export function buildAllowedAuthorities(port, publicUrl = '', includeLocal = true) {
  const authorities = new Set(includeLocal ? [`127.0.0.1:${port}`, `localhost:${port}`] : []);
  if (publicUrl) authorities.add(new URL(publicUrl).host.toLowerCase());
  return authorities;
}

export function buildAllowedOrigins(port, devPort = 5173, publicUrl = '', includeLocal = true) {
  const origins = new Set(includeLocal ? [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${devPort}`,
    `http://localhost:${devPort}`,
  ] : []);
  if (publicUrl) origins.add(new URL(publicUrl).origin);
  return origins;
}

export function isAllowedAuthority(value, allowedAuthorities) {
  if (typeof value !== 'string' || value.length > 255 || /[\s,@/\\]/.test(value)) return false;
  return allowedAuthorities.has(value.toLowerCase());
}

export function isAllowedOrigin(value, allowedOrigins) {
  return typeof value === 'string' && value.length <= 255 && allowedOrigins.has(value);
}

export function isLoopbackPeer(value) {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

export function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length < 32 || candidate.length > 128) return false;
  return constantTimeTextMatches(candidate, expected);
}

function constantTimeTextMatches(candidate, expected) {
  const left = createHash('sha256').update(candidate, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}

export function basicCredentialsMatch(authorization, expectedUsername, expectedPassword) {
  if (typeof authorization !== 'string' || authorization.length > 1024 || !expectedPassword) return false;
  const match = authorization.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return false;
  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const separator = decoded.indexOf(':');
  if (separator < 1) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return constantTimeTextMatches(username, expectedUsername)
    && constantTimeTextMatches(password, expectedPassword);
}

export function applySecurityHeaders(_request, response, next) {
  response.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Strict-Transport-Security': 'max-age=31536000',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
}

export function createSecurityContext({
  port,
  devPort = 5173,
  publicUrl = '',
  allowRemotePeer = false,
  authUsername = '',
  authPassword = '',
  appName = 'Playlist Downloader',
} = {}) {
  const token = randomBytes(32).toString('base64url');
  const allowedAuthorities = buildAllowedAuthorities(port, publicUrl, !allowRemotePeer);
  const allowedOrigins = buildAllowedOrigins(port, devPort, publicUrl, !allowRemotePeer);
  const startAttempts = new Map();
  const authenticationFailures = new Map();
  const authenticationEnabled = Boolean(authPassword);
  const realm = String(appName).replace(/["\\]/g, '').slice(0, 64) || 'Playlist Downloader';

  function boundaryGuard(request, response, next) {
    const remoteAddress = request.socket?.remoteAddress;
    if ((!allowRemotePeer && !isLoopbackPeer(remoteAddress))
      || !isAllowedAuthority(request.headers.host, allowedAuthorities)) {
      response.status(421).json({ error: 'This service only accepts requests from a configured app origin.' });
      return;
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !isAllowedOrigin(origin, allowedOrigins)) {
      response.status(403).json({ error: 'This request did not come from the local app.' });
      return;
    }
    next();
  }

  function requireAuthentication(request, response, next) {
    const isHealthCheck = ['GET', 'HEAD'].includes(request.method) && request.path === '/api/health';
    const isApiRequest = request.path === '/api' || request.path.startsWith('/api/');
    const isPublicDocument = ['GET', 'HEAD'].includes(request.method) && !isApiRequest;
    if (!authenticationEnabled || isHealthCheck || isPublicDocument) {
      next();
      return;
    }

    const key = request.socket?.remoteAddress || 'unknown-peer';
    const now = Date.now();
    const recentFailures = (authenticationFailures.get(key) || [])
      .filter((timestamp) => now - timestamp < AUTH_WINDOW_MS);
    if (basicCredentialsMatch(request.headers.authorization, authUsername, authPassword)) {
      authenticationFailures.delete(key);
      next();
      return;
    }
    if (recentFailures.length >= MAX_AUTH_FAILURES) {
      response.set({ 'Retry-After': String(Math.ceil(AUTH_WINDOW_MS / 1000)), 'Cache-Control': 'no-store' });
      response.status(429).json({ error: 'Too many authentication attempts. Try again later.', code: 'AUTH_RATE_LIMITED' });
      return;
    }
    if (request.headers.authorization) {
      recentFailures.push(now);
      authenticationFailures.set(key, recentFailures);
    }

    response.set({
      'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
    });
    if (isApiRequest) {
      response.status(401).json({ error: 'Authentication is required.', code: 'AUTH_REQUIRED' });
    } else {
      response.status(401).type('text/plain').send('Authentication is required.');
    }
  }

  function requireMutation(request, response, next) {
    if (!isAllowedOrigin(request.headers.origin, allowedOrigins)) {
      response.status(403).json({ error: 'Open the local app in your browser and try again.', code: 'ORIGIN_REQUIRED' });
      return;
    }

    const fetchSite = request.headers['sec-fetch-site'];
    if (fetchSite !== undefined && !SAFE_FETCH_SITES.has(fetchSite)) {
      response.status(403).json({ error: 'Cross-site requests are not allowed.', code: 'CROSS_SITE' });
      return;
    }

    if (!request.is('application/json')) {
      response.status(415).json({ error: 'This endpoint requires a JSON request.', code: 'JSON_REQUIRED' });
      return;
    }

    if (!tokenMatches(request.headers[TOKEN_HEADER], token)) {
      response.status(403).json({ error: 'The local session expired. Refresh the app and try again.', code: 'TOKEN_REQUIRED' });
      return;
    }
    next();
  }

  function limitStarts(request, response, next) {
    const key = request.socket.remoteAddress || 'loopback';
    const now = Date.now();
    const recent = (startAttempts.get(key) || []).filter((timestamp) => now - timestamp < 60_000);
    if (recent.length >= 10) {
      response.set('Retry-After', '60');
      response.status(429).json({ error: 'Too many download attempts. Wait a minute and try again.' });
      return;
    }
    recent.push(now);
    startAttempts.set(key, recent);
    next();
  }

  return {
    token,
    allowedAuthorities,
    allowedOrigins,
    authenticationEnabled,
    boundaryGuard,
    requireAuthentication,
    requireMutation,
    limitStarts,
  };
}
