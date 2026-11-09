import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { conditions, errorResponse, parseRange } from "../http";
import {
	IMMUTABLE,
	downloadPath,
	objectKey,
	parseDownloadPath,
	readJson,
	releaseKey,
	type MirrorRelease,
} from "../releases";
import type { AppContext } from "../types";

export class DownloadAsset extends OpenAPIRoute {
	schema = {
		tags: ["Downloads"],
		summary: "Download a verified mirrored asset",
		description:
			"Serves a fully verified file with a SHA-256 ETag. Supports HEAD, single-range requests, If-Range and conditional requests.",
		request: {
			params: z.object({
				tag: z.string().describe("Release tag, for example v1.3.1"),
				file: z.string().describe("Exact published asset name"),
			}),
		},
		responses: {
			"200": {
				description: "Verified asset bytes",
				content: {
					"application/octet-stream": {
						schema: z.string().openapi({ format: "binary" }),
					},
				},
			},
			"206": { description: "Partial asset bytes for a single byte range" },
			"304": { description: "The client's cached copy is still current" },
			"404": { description: "The release or file is not mirrored yet" },
			"416": { description: "The requested byte range is not supported" },
			"503": { description: "Mirrored object is temporarily unavailable" },
		},
	};

	async handle(c: AppContext) {
		const request = c.req.raw;
		const url = new URL(request.url);
		const path = parseDownloadPath(url.pathname);
		if (!path) return errorResponse(404, "Not found");
		const audit = c.get("audit");
		audit.route = "download";
		const release = await readJson<MirrorRelease>(c.env.RELEASES, releaseKey(path.tag));
		const file = release?.files.find((file) => file.name === path.name);
		if (!release || !file)
			return errorResponse(404, "Release or file is not mirrored yet");
		audit.tag = path.tag;
		audit.file = path.name;
		const etag = `"sha256-${file.sha256}"`;
		const headers = new Headers({
			"Content-Type":
				file.name === "SHA256SUMS" || file.name === "cafe-launcher.rb"
					? "text/plain; charset=utf-8"
					: "application/octet-stream",
			"Content-Disposition": `attachment; filename="${file.name}"`,
			"Cache-Control": c.env.DOWNLOAD_TOKEN ? "private, no-store" : IMMUTABLE,
			"Content-Length": String(file.size),
			"Accept-Ranges": "bytes",
			ETag: etag,
			"Last-Modified": new Date(release.mirroredAt).toUTCString(),
		});
		const precondition = conditions(request, etag, new Date(release.mirroredAt));
		if (precondition) {
			headers.delete("Content-Length");
			return new Response(null, { status: precondition, headers });
		}
		const rawRange = request.method === "GET" ? request.headers.get("Range") : null;
		const ifRange = request.headers.get("If-Range");
		const honorRange =
			!ifRange ||
			ifRange === etag ||
			(!ifRange.includes('"') &&
				Date.parse(ifRange) >= Date.parse(headers.get("Last-Modified")!));
		const range = rawRange && honorRange ? parseRange(rawRange, file.size) : null;
		if (range === false)
			return errorResponse(416, "Requested range is not supported", {
				"Content-Range": `bytes */${file.size}`,
			});

		const cacheKey = new Request(
			`${url.origin}${downloadPath(path.tag, path.name)}?sha256=${file.sha256}`,
		);
		const cacheable = request.method === "GET" && !rawRange;
		if (cacheable) {
			const cached = await caches.default.match(cacheKey);
			if (cached) {
				audit.source = "cache";
				// Authorization and rate limiting have already run, even on cache hits.
				return new Response(cached.body, { status: 200, headers });
			}
		}
		const key = objectKey(path.tag, path.name);
		const downloaded =
			request.method === "HEAD"
				? null
				: await c.env.RELEASES.get(key, range ? { range } : undefined);
		const object =
			request.method === "HEAD" ? await c.env.RELEASES.head(key) : downloaded;
		if (
			!object ||
			object.customMetadata?.sha256 !== file.sha256 ||
			object.size !== file.size
		) {
			return errorResponse(503, "Mirrored file is unavailable");
		}
		audit.source = "r2";
		if (range) {
			headers.set("Content-Length", String(range.length));
			headers.set(
				"Content-Range",
				`bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`,
			);
		}
		const body = downloaded?.body ?? null;
		const response = new Response(body, { status: range ? 206 : 200, headers });
		if (cacheable && !c.env.DOWNLOAD_TOKEN) {
			// Cache failures must not fail the client's verified R2 download.
			c.executionCtx.waitUntil(
				caches.default.put(cacheKey, response.clone()).catch(() => {
					console.warn({ event: "cache_write_failed", tag: path.tag, file: path.name });
				}),
			);
		}
		return response;
	}
}
