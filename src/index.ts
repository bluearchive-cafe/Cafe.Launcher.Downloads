import { ADMIN_PAGE } from './adminPage';
import { CATALOG_KEY, IMMUTABLE, STATUS_KEY, downloadPath, objectKey, parseDownloadPath, readJson, releaseKey, type MirrorRelease } from './releases';
import { synchronize } from './sync';
import { recordRequest, readStatistics } from './statistics';

interface Audit {
  route: string;
  tag: string;
  file: string;
  source: string;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const started = Date.now();
    const audit: Audit = { route: 'unknown', tag: '', file: '', source: 'none' };
    let response: Response;
    try {
      response = await route(request, env, ctx, audit);
    } catch {
      console.error({ event: 'request_error', route: audit.route, tag: audit.tag, file: audit.file });
      response = errorResponse(503, 'Service temporarily unavailable');
    }
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    if (audit.route === 'download') headers.set('X-Mirror-Source', audit.source);
    // Query strings and credentials are never included in the audit payload.
    const bytes = request.method === 'GET' && audit.route === 'download' && [200, 206].includes(response.status)
      ? Number(headers.get('Content-Length') ?? 0) : 0;
    const elapsed = Date.now() - started;
    const method = ['GET', 'HEAD', 'POST', 'OPTIONS'].includes(request.method) ? request.method : 'OTHER';
    const entry = {
      event: 'download_request', route: audit.route, method, tag: audit.tag, file: audit.file,
      status: response.status, source: audit.source, responseBytes: bytes, durationMs: elapsed,
    };
    console.log(entry);
    ctx.waitUntil(recordRequest(env.STATS, entry).catch(() => {
      console.error({ event: 'statistics_write_failed' });
    }));
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(synchronize(env));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext, audit: Audit): Promise<Response> {
  const url = new URL(request.url);
  if (url.search) return errorResponse(400, 'Query parameters are not supported');
  if (url.pathname === '/admin' || url.pathname === '/admin/') {
    audit.route = 'admin_page';
    if (!['GET', 'HEAD'].includes(request.method)) {
      return errorResponse(405, 'Only GET and HEAD are allowed', { Allow: 'GET, HEAD' });
    }
    return adminPage();
  }
  if (url.pathname.startsWith('/admin/')) {
    audit.route = 'admin';
    if (!authorized(request, env.ADMIN_TOKEN)) return errorResponse(401, 'Administrator credentials required');
    if (url.pathname === '/admin/sync' && request.method === 'POST') {
      // Keep the HTTP request connected until this bounded batch completes. Never start
      // a large background copy under HTTP waitUntil's 30-second post-response allowance.
      const result = await synchronize(env);
      return json(result, result.locked ? 409 : result.errors.length ? 502 : 200);
    }
    if (url.pathname === '/admin/status' && ['GET', 'HEAD'].includes(request.method)) {
      return json(await readJson(env.RELEASES, STATUS_KEY) ?? { state: 'not_started' });
    }
    if (url.pathname === '/admin/stats' && ['GET', 'HEAD'].includes(request.method)) {
      return json(await readStatistics(env.STATS));
    }
    return errorResponse(405, 'Method or administrator route is not allowed');
  }
  if (!['GET', 'HEAD'].includes(request.method)) {
    return errorResponse(405, 'Only GET and HEAD are allowed', { Allow: 'GET, HEAD' });
  }
  if (env.DOWNLOAD_TOKEN && !authorized(request, env.DOWNLOAD_TOKEN)) return errorResponse(401, 'Download credentials required');
  // Anonymous downloads have no user identity. This is a generous, approximate per-IP
  // abuse guard, not an exact quota; counters are local to a Cloudflare location.
  const limited = await env.DOWNLOAD_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'local' });
  if (!limited.success) return errorResponse(429, 'Too many requests', { 'Retry-After': '60' });
  if (url.pathname === '/health') {
    audit.route = 'health';
    return json({ service: 'cafe-launcher-downloads', status: 'ok' });
  }
  if (url.pathname === '/' || url.pathname === '/releases') {
    audit.route = 'catalog';
    const releases = await readJson<MirrorRelease[]>(env.RELEASES, CATALOG_KEY) ?? [];
    return json({
      repository: 'bluearchive-cafe/Cafe.Launcher.Avalonia',
      releases: releases.map(release => ({
        ...release,
        files: release.files.map(file => ({ ...file, url: downloadPath(release.tag, file.name) })),
      })),
    });
  }
  const path = parseDownloadPath(url.pathname);
  if (!path) return errorResponse(404, 'Not found');
  audit.route = 'download';
  const release = await readJson<MirrorRelease>(env.RELEASES, releaseKey(path.tag));
  const file = release?.files.find(file => file.name === path.name);
  if (!file) return errorResponse(404, 'Release or file is not mirrored yet');
  audit.tag = path.tag;
  audit.file = path.name;
  const etag = `"sha256-${file.sha256}"`;
  const headers = new Headers({
    'Content-Type': file.name === 'SHA256SUMS' || file.name === 'cafe-launcher.rb' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${file.name}"`,
    'Cache-Control': env.DOWNLOAD_TOKEN ? 'private, no-store' : IMMUTABLE,
    'Content-Length': String(file.size),
    'Accept-Ranges': 'bytes', ETag: etag,
    'Last-Modified': new Date(release!.mirroredAt).toUTCString(),
  });
  const precondition = conditions(request, etag, new Date(release!.mirroredAt));
  if (precondition) {
    headers.delete('Content-Length');
    return new Response(null, { status: precondition, headers });
  }
  const rawRange = request.method === 'GET' ? request.headers.get('Range') : null;
  const ifRange = request.headers.get('If-Range');
  const honorRange = !ifRange || ifRange === etag
    || (!ifRange.includes('"') && Date.parse(ifRange) >= Date.parse(headers.get('Last-Modified')!));
  const range = rawRange && honorRange ? parseRange(rawRange, file.size) : null;
  if (range === false) return errorResponse(416, 'Requested range is not supported', { 'Content-Range': `bytes */${file.size}` });

  const cacheKey = new Request(`${url.origin}${downloadPath(path.tag, path.name)}?sha256=${file.sha256}`);
  const cacheable = request.method === 'GET' && !rawRange;
  if (cacheable) {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      audit.source = 'cache';
      // Authorization and rate limiting have already run, even on cache hits.
      return new Response(cached.body, { status: 200, headers });
    }
  }
  const key = objectKey(path.tag, path.name);
  const downloaded = request.method === 'HEAD' ? null : await env.RELEASES.get(key, range ? { range } : undefined);
  const object = request.method === 'HEAD' ? await env.RELEASES.head(key) : downloaded;
  if (!object || object.customMetadata?.sha256 !== file.sha256 || object.size !== file.size) {
    return errorResponse(503, 'Mirrored file is unavailable');
  }
  audit.source = 'r2';
  if (range) {
    headers.set('Content-Length', String(range.length));
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`);
  }
  const body = downloaded?.body ?? null;
  const response = new Response(body, { status: range ? 206 : 200, headers });
  if (cacheable && !env.DOWNLOAD_TOKEN) {
    // Cache failures must not fail the client's verified R2 download.
    ctx.waitUntil(caches.default.put(cacheKey, response.clone()).catch(() => {
      console.warn({ event: 'cache_write_failed', tag: path.tag, file: path.name });
    }));
  }
  return response;
}

export function authorized(request: Request, secret?: string): boolean {
  if (!secret) return false;
  const supplied = request.headers.get('Authorization') ?? '';
  const expected = `Bearer ${secret}`;
  const encoder = new TextEncoder();
  if (supplied.length !== expected.length) return false;
  const suppliedBytes = encoder.encode(supplied);
  const expectedBytes = encoder.encode(expected);
  if (suppliedBytes.byteLength !== expectedBytes.byteLength) return false;
  return crypto.subtle.timingSafeEqual(suppliedBytes, expectedBytes);
}

export function parseRange(value: string, size: number): { offset: number; length: number } | false {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset) return false;
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

function conditions(request: Request, etag: string, modified: Date): number | null {
  const matches = (value: string, weak = false) => value.split(',').some(item => {
    const candidate = item.trim();
    return candidate === '*' || (weak ? candidate.replace(/^W\//, '') : candidate) === etag;
  });
  const ifMatch = request.headers.get('If-Match');
  if (ifMatch && !matches(ifMatch)) return 412;
  const unmodified = request.headers.get('If-Unmodified-Since');
  const seconds = Math.floor(modified.getTime() / 1000) * 1000;
  if (!ifMatch && unmodified && Date.parse(unmodified) < seconds) return 412;
  const noneMatch = request.headers.get('If-None-Match');
  if (noneMatch && matches(noneMatch, true)) return 304;
  const since = request.headers.get('If-Modified-Since');
  if (!noneMatch && since && Date.parse(since) >= seconds) return 304;
  return null;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function adminPage(): Response {
  return new Response(ADMIN_PAGE, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
    },
  });
}

function errorResponse(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store', ...extra } });
}
