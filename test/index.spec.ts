import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext, reset, createScheduledController } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { parseRange } from '../src/index';
import schema from '../migrations/0001_init.sql?raw';
import { synchronize } from '../src/sync';
import { CATALOG_KEY, REPOSITORY, downloadPath, objectKey, parseDownloadPath, parseManifest, readJson, releaseKey, type GitHubRelease, type MirrorRelease } from '../src/releases';

const tag = 'v1.2.3';
const setup = `Cafe.Launcher_${tag}_setup.exe`;
const zip = `Cafe.Launcher_${tag}_win-x64.zip`;
const linux = `Cafe.Launcher_${tag}_linux-x64.tar.gz`;
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function bindings(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    DOWNLOAD_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ADMIN_TOKEN: 'test-administrator-token',
    ...overrides,
  };
}

async function call(path: string, init: RequestInit<IncomingRequestCfProperties> = {}, options: Partial<Env> = {}) {
  const runtime = bindings(options);
  const ctx = createExecutionContext();
  const response = await worker.fetch(new IncomingRequest(`https://test.example${path}`, init), runtime, ctx);
  const bytes = await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return { response, bytes, text: new TextDecoder().decode(bytes), runtime };
}

async function hash(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), value => value.toString(16).padStart(2, '0')).join('');
}

async function fixture() {
  const bodies: Record<string, string> = { [setup]: 'setup-contents', [zip]: 'portable-contents', [linux]: 'linux-contents' };
  let manifest = '';
  for (const [name, body] of Object.entries(bodies)) manifest += `${await hash(body)}  ${name}\n`;
  bodies.SHA256SUMS = manifest;
  const assets = await Promise.all(Object.entries(bodies).map(async ([name, body], index) => ({
    id: index + 1, name, size: new TextEncoder().encode(body).byteLength,
    state: 'uploaded', digest: `sha256:${await hash(body)}`,
    browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`,
  })));
  const release: GitHubRelease = { tag_name: tag, draft: false, prerelease: false, published_at: '2026-11-08T10:00:00Z', assets };
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input);
    if (url === `https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`) return Response.json([release]);
    if (url === 'https://api.cafe-launcher.saibamidori.com/api/v2/launcher/releases') {
      return Response.json([{
        version: release.tag_name.slice(1), releaseDate: release.published_at,
        files: release.assets.map(asset => ({ name: asset.name, url: asset.browser_download_url, size: asset.size, checksum: asset.digest })),
      }]);
    }
    const asset = release.assets.find(asset => asset.browser_download_url === url);
    if (!asset) throw new Error('Unexpected network request');
    return new Response(bodies[asset.name], { headers: { 'Content-Length': String(asset.size) } });
  });
  return { release, bodies, network };
}

async function seed() {
  const sha256 = await hash('0123456789');
  await env.RELEASES.put(objectKey(tag, setup), '0123456789', { sha256, customMetadata: { sha256, assetId: '1' } });
  const release: MirrorRelease = {
    tag, prerelease: false, publishedAt: '2026-11-08T10:00:00Z', mirroredAt: '2026-11-08T11:00:00Z',
    files: [{ name: setup, size: 10, sha256, assetId: 1 }],
  };
  await env.RELEASES.put(releaseKey(tag), JSON.stringify(release));
  await env.RELEASES.put(CATALOG_KEY, JSON.stringify([release]));
  return release;
}

beforeEach(async () => {
  await reset();
  await env.STATS.exec(schema.replace(/\r?\n/g, ' '));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('release synchronization', () => {
  it('copies only a bounded batch, resumes, publishes a complete verified release and skips existing bytes', async () => {
    const { network } = await fixture();
    const first = await synchronize(bindings());
    expect(first.errors).toEqual([]);
    expect(first.uploaded).toBe(2);
    expect(first.pending).toEqual([tag]);
    expect(await env.RELEASES.head(objectKey(tag, setup))).not.toBeNull();
    expect(await env.RELEASES.head(objectKey(tag, zip))).not.toBeNull();
    expect(await env.RELEASES.head(releaseKey(tag))).toBeNull();
    const second = await synchronize(bindings());
    expect(second.errors).toEqual([]);
    expect(second.uploaded).toBe(1);
    expect(second.ready).toEqual([tag]);
    const ready = await readJson<MirrorRelease>(env.RELEASES, releaseKey(tag));
    expect(ready?.files).toHaveLength(4);
    network.mockClear();
    const third = await synchronize(bindings());
    expect(third.uploaded).toBe(0);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('does not publish or store a corrupted package', async () => {
    const { bodies } = await fixture();
    bodies[setup] = 'bad-package!!!';
    const result = await synchronize(bindings());
    expect(result.errors).toHaveLength(1);
    expect(await env.RELEASES.head(objectKey(tag, setup))).toBeNull();
    expect(await env.RELEASES.head(releaseKey(tag))).toBeNull();
  });

  it('waits for all manifest entries to appear in a release', async () => {
    const { release } = await fixture();
    release.assets = release.assets.filter(asset => asset.name !== zip);
    const result = await synchronize(bindings());
    expect(result.errors[0].message).toContain('incomplete');
    expect((await env.RELEASES.list({ prefix: 'releases/' })).objects).toHaveLength(0);
  });

  it('rejects arbitrary origins before any binary fetch', async () => {
    const { release, network } = await fixture();
    release.assets[0].browser_download_url = 'https://evil.example/package';
    const result = await synchronize(bindings());
    expect(result.errors).toHaveLength(1);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('rejects manifest hashes that conflict with GitHub asset digests', async () => {
    const { release } = await fixture();
    release.assets[0].digest = `sha256:${'a'.repeat(64)}`;
    const result = await synchronize(bindings());
    expect(result.errors[0].message).toContain('conflicts');
    expect(await env.RELEASES.head(releaseKey(tag))).toBeNull();
  });

  it('refuses to overwrite different bytes under an immutable path', async () => {
    await fixture();
    await env.RELEASES.put(objectKey(tag, setup), 'different');
    const result = await synchronize(bindings());
    expect(result.errors[0].message).toContain('conflicts');
    expect(await (await env.RELEASES.get(objectKey(tag, setup)))?.text()).toBe('different');
  });

  it('reports replaced assets after a tag was pinned', async () => {
    const { release } = await fixture();
    await synchronize(bindings());
    await synchronize(bindings());
    release.assets[0].id = 101;
    expect((await synchronize(bindings())).errors[0].message).toContain('changed');
  });

  it('honors the global sync lease', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    await env.RELEASES.put('_state/sync-lock', 'other', { customMetadata: { expires: String(Date.now() + 60_000) } });
    expect((await synchronize(bindings())).locked).toBe(true);
    expect(network).not.toHaveBeenCalled();
  });

  it('records upstream failure and releases the lease for a later retry', async () => {
    const { network } = await fixture();
    network.mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    const first = await synchronize(bindings());
    expect(first.errors[0].message).toContain('503');
    expect((await synchronize(bindings())).locked).toBe(false);
  });

  it('rejects an unexpected GitHub API redirect without forwarding credentials', async () => {
    const { network } = await fixture();
    network.mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://evil.example/' } }))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));
    expect((await synchronize(bindings({ GITHUB_TOKEN: 'private-test-token' }))).errors[0].message).toContain('503');
    expect(network).toHaveBeenCalledTimes(2);
    expect(network.mock.calls[0][1]?.redirect).toBe('manual');
    expect(new Headers(network.mock.calls[1][1]?.headers).has('Authorization')).toBe(false);
  });

  it('uses the existing metadata proxy on shared GitHub API rate limits without requiring source asset IDs', async () => {
    const { network } = await fixture();
    network.mockResolvedValueOnce(new Response('rate limited', { status: 403 }));
    const first = await synchronize(bindings());
    expect(first.metadataSource).toBe('launcher-api');
    expect(first.errors).toEqual([]);
    expect(first.uploaded).toBe(2);
    const second = await synchronize(bindings());
    expect(second.errors).toEqual([]);
    expect(second.ready).toEqual([tag]);
  });

  it('executes synchronization from the scheduled handler', async () => {
    await fixture();
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '*/10 * * * *' }), bindings(), ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.RELEASES.head(objectKey(tag, setup))).not.toBeNull();
  });
});

describe('download gateway', () => {
  it('serves a published asset with hash ETag and records declared response bytes', async () => {
    await seed();
    const { response, text } = await call(downloadPath(tag, setup));
    expect(response.status).toBe(200);
    expect(text).toBe('0123456789');
    expect(response.headers.get('Content-Disposition')).toContain(setup);
    expect(response.headers.get('ETag')).toContain('sha256-');
    const recorded = await env.STATS.prepare('SELECT SUM(response_bytes) AS bytes FROM traffic_daily').first<number>('bytes');
    expect(recorded).toBe(10);
  });

  it.each([['bytes=2-4', '234', 'bytes 2-4/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=7-', '789', 'bytes 7-9/10']])('supports range %s', async (range, expected, contentRange) => {
    await seed();
    const { response, text } = await call(downloadPath(tag, setup), { headers: { Range: range } });
    expect(response.status).toBe(206);
    expect(text).toBe(expected);
    expect(response.headers.get('Content-Range')).toBe(contentRange);
    expect(response.headers.get('Content-Length')).toBe('3');
  });

  it('rejects unsupported multi-range requests', async () => {
    await seed();
    const { response } = await call(downloadPath(tag, setup), { headers: { Range: 'bytes=0-1,4-5' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe('bytes */10');
  });

  it('returns a full file when If-Range does not match', async () => {
    await seed();
    const { response, text } = await call(downloadPath(tag, setup), { headers: { Range: 'bytes=0-2', 'If-Range': '"old"' } });
    expect(response.status).toBe(200);
    expect(text).toHaveLength(10);
  });

  it('returns metadata without a body or download bytes for HEAD', async () => {
    await seed();
    const { response, bytes } = await call(downloadPath(tag, setup), { method: 'HEAD' });
    expect(response.headers.get('Content-Length')).toBe('10');
    expect(bytes.byteLength).toBe(0);
    expect(await env.STATS.prepare('SELECT SUM(response_bytes) AS bytes FROM traffic_daily').first<number>('bytes')).toBe(0);
  });

  it('handles weak If-None-Match and preconditions without download bytes', async () => {
    const release = await seed();
    const { response } = await call(downloadPath(tag, setup), { headers: { 'If-None-Match': `W/"sha256-${release.files[0].sha256}"` } });
    expect(response.status).toBe(304);
    expect(response.headers.get('Content-Length')).toBeNull();
    expect((await call(downloadPath(tag, setup), { headers: { 'If-Match': '"old"' } })).response.status).toBe(412);
  });

  it('does not expose unfinished packages or internal state keys', async () => {
    await env.RELEASES.put(objectKey(tag, setup), 'unverified');
    expect((await call(downloadPath(tag, setup))).response.status).toBe(404);
    expect((await call('/_state/catalog.json')).response.status).toBe(404);
  });

  it('enforces bearer access before cached responses and marks authenticated responses private', async () => {
    await seed();
    await call(downloadPath(tag, setup));
    expect((await call(downloadPath(tag, setup), {}, { DOWNLOAD_TOKEN: 'restricted' })).response.status).toBe(401);
    const allowed = await call(downloadPath(tag, setup), { headers: { Authorization: 'Bearer restricted' } }, { DOWNLOAD_TOKEN: 'restricted' });
    expect(allowed.text).toBe('0123456789');
    expect(allowed.response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('limits cache hits as well as misses', async () => {
    await seed();
    await call(downloadPath(tag, setup));
    const blocked = await call(downloadPath(tag, setup), {}, { DOWNLOAD_LIMITER: { limit: vi.fn(async () => ({ success: false })) } });
    expect(blocked.response.status).toBe(429);
    expect(blocked.response.headers.get('Retry-After')).toBe('60');
  });

  it('rejects write methods and token-in-query access', async () => {
    expect((await call(downloadPath(tag, setup), { method: 'PUT' })).response.status).toBe(405);
    expect((await call('/releases?token=secret')).response.status).toBe(400);
  });

  it('protects manual sync and sync status', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    expect((await call('/admin/sync', { method: 'POST' })).response.status).toBe(401);
    expect(network).not.toHaveBeenCalled();
    expect((await call('/admin/status', { headers: { Authorization: 'Bearer test-administrator-token' } })).response.status).toBe(200);
  });

  it('serves the management page without credentials while JSON admin routes stay protected', async () => {
    const page = await call('/admin');
    expect(page.response.status).toBe(200);
    expect(page.response.headers.get('Content-Type')).toContain('text/html');
    expect(page.response.headers.get('Content-Security-Policy')).toContain("connect-src 'self'");
    expect(page.text).toContain('Cafe Launcher 下载镜像');
    expect((await call('/admin/')).response.status).toBe(200);
    expect((await call('/admin', { method: 'POST' })).response.status).toBe(405);
    expect((await call('/admin/status')).response.status).toBe(401);
    expect((await call('/admin/stats')).response.status).toBe(401);
  });

  it('rejects non-ASCII credentials with matching character length without throwing', async () => {
    const token = 'é'.repeat('test-administrator-token'.length);
    expect((await call('/admin/status', { headers: { Authorization: `Bearer ${token}` } })).response.status).toBe(401);
  });

  it('returns zero summary counters for an empty statistics database', async () => {
    const result = await call('/admin/stats', { headers: { Authorization: 'Bearer test-administrator-token' } });
    expect(JSON.parse(result.text).summary).toEqual({ requests: 0, declaredResponseBytes: 0, rejectedOrFailedRequests: 0 });
  });

  it('aggregates repeated downloads including cache hits and restricts statistics to administrators', async () => {
    await seed();
    await call(downloadPath(tag, setup));
    const second = await call(downloadPath(tag, setup));
    expect(second.response.headers.get('X-Mirror-Source')).toBe('cache');
    expect((await call('/admin/stats')).response.status).toBe(401);
    const stats = await call('/admin/stats', { headers: { Authorization: 'Bearer test-administrator-token' } });
    const rows = JSON.parse(stats.text).rows.filter((row: { route: string }) => row.route === 'download');
    expect(rows.reduce((sum: number, row: { requests: number }) => sum + row.requests, 0)).toBe(2);
    expect(rows.reduce((sum: number, row: { declaredResponseBytes: number }) => sum + row.declaredResponseBytes, 0)).toBe(20);
  });

  it('counts completed full downloads per file and excludes partial or metadata requests', async () => {
    await seed();
    await call(downloadPath(tag, setup));
    await call(downloadPath(tag, setup));
    await call(downloadPath(tag, setup), { method: 'HEAD' });
    await call(downloadPath(tag, setup), { headers: { Range: 'bytes=0-4' } });
    const stats = await call('/admin/stats', { headers: { Authorization: 'Bearer test-administrator-token' } });
    const payload = JSON.parse(stats.text);
    expect(payload.downloadMetric).toContain('GET 200');
    expect(payload.fileDownloads.files).toEqual([
      { tag, file: setup, downloads: 2, declaredResponseBytes: 20 },
    ]);
  });

  it('does not serve the release catalog at the interface root', async () => {
    await seed();
    expect((await call('/')).response.status).toBe(404);
    expect((await call('/', { method: 'HEAD' })).response.status).toBe(404);
  });

  it('serves the same interface under the /v1 version prefix', async () => {
    await seed();
    const catalog = await call('/v1/releases');
    expect(catalog.response.status).toBe(200);
    expect(JSON.parse(catalog.text).releases[0].files[0].url).toBe(downloadPath(tag, setup));
    expect((await call(`/v1/downloads/${tag}/${setup}`)).response.status).toBe(200);
    expect((await call('/v1/admin/status', { headers: { Authorization: 'Bearer test-administrator-token' } })).response.status).toBe(200);
    expect((await call('/v1')).response.status).toBe(404);
  });

  it('returns only completed releases and public download URLs', async () => {
    await seed();
    const { text } = await call('/releases');
    const catalog = JSON.parse(text);
    expect(catalog.releases[0].files[0].url).toBe(downloadPath(tag, setup));
    expect(catalog.releases[0].files[0].url).toContain('/v1/downloads/');
    expect(text).not.toContain('_state/');
  });

  it('excludes authorization, IP addresses and query values from explicit logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await call('/releases?token=sensitive-query', { headers: { Authorization: 'Bearer sensitive-token', 'CF-Connecting-IP': '192.0.2.1' } });
    const output = JSON.stringify(log.mock.calls);
    expect(output).not.toContain('sensitive');
    expect(output).not.toContain('192.0.2.1');
  });
});

describe('input boundaries', () => {
  it('accepts the version prefix in download paths', () => {
    expect(parseDownloadPath(`/v1/downloads/${tag}/${setup}`)).toEqual({ tag, name: setup });
  });
  it.each(['/downloads/v1.2.3/%2e%2e%2fsecret', '/downloads/v1.2.3/%ZZ', '/downloads/main/SHA256SUMS', '/downloads/v1.2.3/Cafe.Launcher_v9.9.9_setup.exe', '/v1/downloads/v1.2.3/%2e%2e%2fsecret'])('rejects invalid paths %s', path => {
    expect(parseDownloadPath(path)).toBeNull();
  });
  it.each(['bytes=-0', 'bytes=10-', 'bytes=4-1', 'bytes=9007199254740992-', 'items=0-1'])('rejects invalid ranges %s', range => {
    expect(parseRange(range, 10)).toBe(false);
  });
  it('rejects duplicate checksum entries', () => {
    const line = `${'a'.repeat(64)}  ${setup}\n`;
    expect(() => parseManifest(line + line, tag)).toThrow('duplicate');
  });
});
