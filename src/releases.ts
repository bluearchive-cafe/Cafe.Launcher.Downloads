export const REPOSITORY = 'bluearchive-cafe/Cafe.Launcher.Avalonia';
export const MAX_ASSET_BYTES = 512 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const CATALOG_KEY = '_state/catalog.json';
export const STATUS_KEY = '_state/sync.json';
export const API_PREFIX = '/v1';

const TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SUFFIXES = ['setup.exe', 'win-x64.zip', 'osx-arm64.zip', 'linux-x64.tar.gz', 'linux-x64.AppImage', 'linux-x64.deb', 'linux-x64.rpm', 'linux-x64.pkg.tar.zst'];

export interface GitHubAsset {
  id?: number;
  name: string;
  size: number;
  state: string;
  digest: string | null;
  browser_download_url: string;
}

export interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: GitHubAsset[];
}

export interface MirrorFile {
  name: string;
  size: number;
  sha256: string;
  assetId?: number;
}

export interface MirrorRelease {
  tag: string;
  prerelease: boolean;
  publishedAt: string;
  mirroredAt: string;
  files: MirrorFile[];
}

export function validTag(tag: string): boolean {
  return typeof tag === 'string' && tag.length <= 100 && TAG.test(tag);
}

export function validName(tag: string, name: string): boolean {
  if (name === 'SHA256SUMS' || name === 'cafe-launcher.rb') return true;
  return ['Cafe.Launcher', 'Cafe.Launcher.Avalonia'].some(prefix =>
    SUFFIXES.some(suffix => name === `${prefix}_${tag}_${suffix}`));
}

export function releaseKey(tag: string): string { return `_state/releases/${tag}.json`; }
export function objectKey(tag: string, name: string): string { return `releases/${tag}/${name}`; }
export function downloadPath(tag: string, name: string): string {
  return `${API_PREFIX}/downloads/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export function parseDownloadPath(path: string): { tag: string; name: string } | null {
  const match = new RegExp(`^(?:${API_PREFIX})?/downloads/([^/]+)/([^/]+)$`).exec(path);
  if (!match) return null;
  try {
    const tag = decodeURIComponent(match[1]);
    const name = decodeURIComponent(match[2]);
    return validTag(tag) && validName(tag, name) ? { tag, name } : null;
  } catch { return null; }
}

export function digestOf(asset: GitHubAsset): string | null {
  return /^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '') ? asset.digest!.slice(7).toLowerCase() : null;
}

export function parseManifest(text: string, tag: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64}) [ *](\S+)$/i.exec(line);
    if (!match || !validName(tag, match[2]) || match[2] === 'SHA256SUMS' || entries.has(match[2])) {
      throw new Error('Invalid or duplicate checksum manifest entry');
    }
    entries.set(match[2], match[1].toLowerCase());
  }
  if (!entries.size) throw new Error('Empty checksum manifest');
  return entries;
}

export function validateAssets(release: GitHubRelease): GitHubAsset[] {
  const tag = release.tag_name;
  if (release.draft || !validTag(tag)) throw new Error('Release is not public or has an invalid tag');
  if (!Array.isArray(release.assets) || release.assets.length < 2 || release.assets.length > 16) {
    throw new Error('Release assets are incomplete or exceed the supported set');
  }
  const names = new Set<string>();
  for (const asset of release.assets) {
    const expected = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset.name)}`;
    if (!validName(tag, asset.name) || names.has(asset.name) || asset.state !== 'uploaded'
      || (asset.id !== undefined && (!Number.isSafeInteger(asset.id) || asset.id <= 0))
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES
      || asset.browser_download_url !== expected) {
      throw new Error('Invalid, incomplete, duplicate, or oversized release asset');
    }
    names.add(asset.name);
  }
  if (!names.has('SHA256SUMS')) throw new Error('Release has no checksum manifest');
  return [...release.assets].sort((a, b) => priority(a.name) - priority(b.name) || a.name.localeCompare(b.name));
}

function priority(name: string): number {
  return name === 'SHA256SUMS' ? 0 : name.endsWith('_setup.exe') ? 1 : name.endsWith('_win-x64.zip') ? 2 : 3;
}

// Binary requests carry no API token. Follow only GitHub's known asset redirect hosts.
export async function fetchAsset(asset: GitHubAsset, signal: AbortSignal): Promise<Response> {
  let url = new URL(asset.browser_download_url);
  for (let hop = 0; hop < 5; hop++) {
    if (url.protocol !== 'https:' || url.port || url.username || url.password
      || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) {
      throw new Error('Asset redirect host was rejected');
    }
    const response = await fetch(url, {
      redirect: 'manual', signal,
      headers: { 'User-Agent': 'CafeLauncherDownloads/1.0', 'Accept-Encoding': 'identity' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('Location');
      await response.body?.cancel();
      if (!location) throw new Error('Missing asset redirect location');
      url = new URL(location, url);
      continue;
    }
    if (response.status !== 200 || !response.body
      || Number(response.headers.get('Content-Length')) !== asset.size
      || (response.headers.get('Content-Encoding') ?? 'identity') !== 'identity') {
      await response.body?.cancel();
      throw new Error(`Asset response rejected (HTTP ${response.status}, size or encoding mismatch)`);
    }
    return response;
  }
  throw new Error('Too many asset redirects');
}

export async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? object.json<T>() : null;
}
