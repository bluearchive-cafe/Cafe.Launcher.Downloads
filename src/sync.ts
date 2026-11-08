import {
  CATALOG_KEY, IMMUTABLE, MAX_MANIFEST_BYTES, REPOSITORY, STATUS_KEY,
  digestOf, fetchAsset, objectKey, parseManifest, readJson, releaseKey, validTag, validateAssets,
  type GitHubAsset, type GitHubRelease, type MirrorFile, type MirrorRelease,
} from './releases';

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  uploaded: number;
  uploadedBytes: number;
  ready: string[];
  pending: string[];
  errors: { tag: string; message: string }[];
  locked: boolean;
  metadataSource: string;
}

const LOCK = '_state/sync-lock';

export async function synchronize(env: Env): Promise<SyncResult> {
  const start = Date.now();
  const result: SyncResult = {
    startedAt: new Date(start).toISOString(), finishedAt: '', uploaded: 0, uploadedBytes: 0,
    ready: [], pending: [], errors: [], locked: false, metadataSource: '',
  };
  const previousLock = await env.RELEASES.head(LOCK);
  if (Number(previousLock?.customMetadata?.expires ?? 0) > start) {
    result.locked = true;
    result.finishedAt = new Date().toISOString();
    return result;
  }
  const lock = await env.RELEASES.put(LOCK, crypto.randomUUID(), {
    onlyIf: previousLock ? { etagMatches: previousLock.etag } : { etagDoesNotMatch: '*' },
    customMetadata: { expires: String(start + 9 * 60_000) },
  });
  if (!lock) {
    result.locked = true;
    result.finishedAt = new Date().toISOString();
    return result;
  }
  try {
    const feed = await fetchReleases(env);
    const allReleases = feed.releases;
    result.metadataSource = feed.source;
    const releases = allReleases.filter(release => !release.draft && validTag(release.tag_name))
      .slice(0, integerSetting(env.SYNC_RELEASE_COUNT, 3, 5));
    const limit = integerSetting(env.SYNC_ASSET_LIMIT, 2, 4);
    const catalog = await readJson<MirrorRelease[]>(env.RELEASES, CATALOG_KEY) ?? [];

    for (const release of releases) {
      if (Date.now() - start > 7 * 60_000) break;
      const tag = release.tag_name;
      try {
        const assets = validateAssets(release);
        const pinned = await readJson<MirrorRelease>(env.RELEASES, releaseKey(tag));
        if (pinned) {
          if (assets.length !== pinned.files.length || assets.some(asset => {
            const file = pinned.files.find(file => file.name === asset.name);
            return !file || (file.assetId !== undefined && asset.id !== undefined && file.assetId !== asset.id) || file.size !== asset.size
              || (digestOf(asset) !== null && digestOf(asset) !== file.sha256);
          })) throw new Error('Published tag assets changed; immutable mirror requires operator review');
          result.ready.push(tag);
          if (!catalog.some(item => item.tag === tag)) catalog.push(pinned);
          continue;
        }
        if (result.uploaded >= limit) { result.pending.push(tag); continue; }
        const manifest = assets.find(asset => asset.name === 'SHA256SUMS')!;
        if (manifest.size > MAX_MANIFEST_BYTES) throw new Error('Checksum manifest is too large');
        const manifestResponse = await fetchAsset(manifest, AbortSignal.timeout(20_000));
        const manifestBytes = await manifestResponse.arrayBuffer();
        const manifestHash = hex(await crypto.subtle.digest('SHA-256', manifestBytes));
        if (digestOf(manifest) && digestOf(manifest) !== manifestHash) throw new Error('Manifest digest mismatch');
        const hashes = parseManifest(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(manifestBytes), tag);
        if (hashes.size !== assets.length - 1 || [...hashes.keys()].some(name => !assets.some(asset => asset.name === name))) {
          throw new Error('Release upload is incomplete: checksum manifest and assets differ');
        }
        const files: MirrorFile[] = assets.map(asset => {
          const sha256 = asset.name === 'SHA256SUMS' ? manifestHash : hashes.get(asset.name)!;
          if (!sha256 || (digestOf(asset) && digestOf(asset) !== sha256)) throw new Error('Asset digest conflicts with manifest');
          return { name: asset.name, size: asset.size, sha256, assetId: asset.id };
        });
        let complete = true;
        for (const file of files) {
          const key = objectKey(tag, file.name);
          const existing = await env.RELEASES.head(key);
          if (existing) {
            if (existing.size !== file.size || existing.customMetadata?.sha256 !== file.sha256
              || (file.assetId !== undefined && existing.customMetadata?.assetId
                && existing.customMetadata.assetId !== String(file.assetId))) {
              throw new Error('Existing mirrored object conflicts with source; refusing overwrite');
            }
            continue;
          }
          if (file.name !== 'SHA256SUMS' && (result.uploaded >= limit || Date.now() - start > 7 * 60_000)) {
            complete = false;
            continue;
          }
          const asset = assets.find(asset => asset.name === file.name)!;
          await upload(env.RELEASES, tag, asset, file.sha256, asset.name === 'SHA256SUMS' ? manifestBytes : undefined);
          if (file.name !== 'SHA256SUMS') result.uploaded++;
          result.uploadedBytes += file.size;
          console.log({ event: 'sync_asset', tag, file: file.name, bytes: file.size, sha256: file.sha256 });
        }
        if (complete) {
          const ready: MirrorRelease = {
            tag, prerelease: release.prerelease, publishedAt: release.published_at,
            mirroredAt: new Date().toISOString(), files,
          };
          await env.RELEASES.put(releaseKey(tag), JSON.stringify(ready), { httpMetadata: { contentType: 'application/json' } });
          if (!catalog.some(item => item.tag === tag)) catalog.push(ready);
          result.ready.push(tag);
        } else result.pending.push(tag);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown sync error';
        result.errors.push({ tag, message: safeError(message) });
      }
    }
    catalog.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    await env.RELEASES.put(CATALOG_KEY, JSON.stringify(catalog), { httpMetadata: { contentType: 'application/json' } });
  } catch (error) {
    result.errors.push({ tag: '', message: safeError(error instanceof Error ? error.message : 'Sync failed') });
  } finally {
    result.finishedAt = new Date().toISOString();
    await env.RELEASES.put(STATUS_KEY, JSON.stringify(result), { httpMetadata: { contentType: 'application/json' } });
    await env.RELEASES.put(LOCK, 'idle', { onlyIf: { etagMatches: lock.etag }, customMetadata: { expires: '0' } });
    console.log({ event: 'sync_complete', ...result });
  }
  return result;
}

async function upload(bucket: R2Bucket, tag: string, asset: GitHubAsset, sha256: string, bytes?: ArrayBuffer): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = bytes ? null : await fetchAsset(asset, controller.signal);
    const stored = await bucket.put(objectKey(tag, asset.name), bytes ?? response!.body!, {
      sha256,
      onlyIf: { etagDoesNotMatch: '*' },
      httpMetadata: {
        contentType: asset.name === 'SHA256SUMS' || asset.name === 'cafe-launcher.rb' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        contentDisposition: `attachment; filename="${asset.name}"`, cacheControl: IMMUTABLE,
      },
      customMetadata: { sha256, assetId: asset.id === undefined ? '' : String(asset.id), tag },
    });
    if (!stored || stored.size !== asset.size) throw new Error('Upload conflict or size mismatch');
  } finally { clearTimeout(timeout); }
}

function integerSetting(value: string, fallback: number, max: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= max ? number : fallback;
}

// Reuse the product's existing, authenticated metadata proxy when GitHub's shared
// anonymous API egress is rate limited. All binary URLs and checksums still pass
// the same fixed-repository validation; no secret is sent to this fallback.
async function fetchReleases(env: Env): Promise<{ releases: GitHubRelease[]; source: string }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json', 'User-Agent': 'CafeLauncherDownloads/1.0',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`, {
      headers, signal: AbortSignal.timeout(20_000), redirect: 'manual',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`GitHub release API returned HTTP ${response.status}`);
    }
    const releases = await response.json<GitHubRelease[]>();
    if (!Array.isArray(releases)) throw new Error('GitHub did not return a release list');
    return { releases, source: 'github' };
  } catch {
    console.warn({ event: 'metadata_fallback', source: 'launcher-api' });
  }
  const response = await fetch('https://api-cafe-launcher.saibamidori.com/api/v2/launcher/releases', {
    headers: { Accept: 'application/json', 'User-Agent': 'CafeLauncherDownloads/1.0' },
    redirect: 'manual', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Metadata fallback returned HTTP ${response.status}`);
  const releases = await response.json<{
    version: string; releaseDate: string;
    files: { name: string; url: string; size: number; checksum: string | null }[];
  }[]>();
  if (!Array.isArray(releases)) throw new Error('Invalid metadata fallback response');
  return {
    source: 'launcher-api',
    releases: releases.slice(0, 20).map(release => ({
      tag_name: `v${release.version}`, draft: false, prerelease: release.version.includes('-'),
      published_at: release.releaseDate,
      assets: release.files.map(file => ({
        name: file.name, size: file.size, state: 'uploaded',
        digest: file.checksum, browser_download_url: file.url,
      })),
    })),
  };
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

function safeError(message: string): string {
  return message.replace(/https?:\/\/\S+/g, '[upstream]').slice(0, 250);
}
