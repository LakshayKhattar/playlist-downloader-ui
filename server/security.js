import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_HEADER = 'x-playlist-token';
const SAFE_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

export function buildAllowedAuthorities(port, publicUrl = '') {
  const authorities = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (publicUrl) authorities.add(new URL(publicUrl).host.toLowerCase());
  return authorities;
}

export function buildAllowedOrigins(port, devPort = 5173, publicUrl = '') {
  const origins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${devPort}`,
    `http://localhost:${devPort}`,
  ]);
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
  const left = createHash('sha256').update(candidate, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}

export function applySecurityHeaders(_request, response, next) {
  response.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
}

export function createSecurityContext({ port, devPort = 5173, publicUrl = '' } = {}) {
  const token = randomBytes(32).toString('base64url');
  const allowedAuthorities = buildAllowedAuthorities(port, publicUrl);
  const allowedOrigins = buildAllowedOrigins(port, devPort, publicUrl);
  const startAttempts = new Map();

  function boundaryGuard(request, response, next) {
    const remoteAddress = request.socket?.remoteAddress;
    if (!isLoopbackPeer(remoteAddress) || !isAllowedAuthority(request.headers.host, allowedAuthorities)) {
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
    boundaryGuard,
    requireMutation,
    limitStarts,
  };
}
