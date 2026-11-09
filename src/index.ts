import { fromHono } from "chanfana";
import { Hono } from "hono";
import { adminPage, authorized, errorResponse } from "./http";
import { AdminStats, AdminStatus, AdminSync } from "./routes/admin";
import { DownloadAsset } from "./routes/download";
import { Health } from "./routes/health";
import { ReleaseCatalog } from "./routes/releases";
import { recordRequest } from "./statistics";
import { synchronize } from "./sync";
import type { Audit, Variables } from "./types";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const openapi = fromHono(app, {
	docs_url: "/docs",
	openapi_url: "/openapi.json",
	schema: {
		info: {
			title: "Cafe Launcher OpenAPI",
			version: "1.0.0",
			description:
				"Open API for Cafe Launcher services. Administration routes require an ADMIN_TOKEN bearer credential. Public routes can optionally require a separate DOWNLOAD_TOKEN bearer credential.",
		},
	},
});

// Reject query strings, apply authentication and the approximate per-IP abuse
// guard, then attach security headers and record sanitized request metrics.
app.use("*", async (c, next) => {
	const started = Date.now();
	const url = new URL(c.req.url);
	const audit: Audit = { route: "unknown", tag: "", file: "", source: "none" };
	c.set("audit", audit);
	const pathname = url.pathname;
	const isAdminPage = pathname === "/v1/admin" || pathname === "/v1/admin/";
	const isAdmin = isAdminPage || pathname.startsWith("/v1/admin/");
	const isDocs = pathname === "/docs" || pathname === "/openapi.json";
	let response: Response | undefined;
	if (url.search) {
		response = errorResponse(400, "Query parameters are not supported");
	} else if (isAdminPage) {
		audit.route = "admin_page";
		if (requestMethod(c.req.raw) !== "GET" && requestMethod(c.req.raw) !== "HEAD") {
			response = errorResponse(405, "Only GET and HEAD are allowed", {
				Allow: "GET, HEAD",
			});
		}
	} else if (isAdmin) {
		audit.route = "admin";
		if (!authorized(c.req.raw, c.env.ADMIN_TOKEN)) {
			response = errorResponse(401, "Administrator credentials required");
		}
	} else if (!isDocs) {
		const method = requestMethod(c.req.raw);
		if (method !== "GET" && method !== "HEAD") {
			response = errorResponse(405, "Only GET and HEAD are allowed", {
				Allow: "GET, HEAD",
			});
		} else if (c.env.DOWNLOAD_TOKEN && !authorized(c.req.raw, c.env.DOWNLOAD_TOKEN)) {
			response = errorResponse(401, "Download credentials required");
		} else {
			// Anonymous downloads have no user identity. This is a generous, approximate
			// per-IP abuse guard, not an exact quota; counters are local to a location.
			const limited = await c.env.DOWNLOAD_LIMITER.limit({
				key: c.req.raw.headers.get("CF-Connecting-IP") ?? "local",
			});
			if (!limited.success) {
				response = errorResponse(429, "Too many requests", { "Retry-After": "60" });
			}
		}
	}
	if (!response) {
		try {
			await next();
			response = c.res;
		} catch {
			console.error({
				event: "request_error",
				route: audit.route,
				tag: audit.tag,
				file: audit.file,
			});
			response = errorResponse(503, "Service temporarily unavailable");
		}
	}
	const headers = new Headers(response.headers);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Referrer-Policy", "no-referrer");
	if (audit.route === "download") headers.set("X-Mirror-Source", audit.source);
	const method = requestMethod(c.req.raw);
	const bytes =
		method === "GET" &&
		audit.route === "download" &&
		[200, 206].includes(response.status)
			? Number(headers.get("Content-Length") ?? 0)
			: 0;
	const entry = {
		event: "download_request",
		route: audit.route,
		method,
		tag: audit.tag,
		file: audit.file,
		status: response.status,
		source: audit.source,
		responseBytes: bytes,
		durationMs: Date.now() - started,
	};
	// Query strings and credentials are never included in the audit payload.
	console.log(entry);
	c.executionCtx.waitUntil(
		recordRequest(c.env.STATS, entry).catch(() => {
			console.error({ event: "statistics_write_failed" });
		}),
	);
	const body =
		method === "HEAD" || [204, 205, 304].includes(response.status)
			? null
			: response.body;
	c.res = new Response(body, { status: response.status, headers });
});

app.get("/v1/admin", () => adminPage());
app.get("/v1/admin/", () => adminPage());

openapi.get("/v1/health", Health);
openapi.get("/v1/releases", ReleaseCatalog);
openapi.get("/v1/downloads/:tag/:file", DownloadAsset);
openapi.get("/v1/admin/status", AdminStatus);
openapi.get("/v1/admin/stats", AdminStats);
openapi.post("/v1/admin/sync", AdminSync);

app.all("/v1/admin/*", () =>
	errorResponse(405, "Method or administrator route is not allowed"),
);

const handler = {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const canonical = canonicalUrl(url);
		const actual = canonical
			? new Request(canonical, {
					method: request.method,
					headers: request.headers,
					body: request.body,
					redirect: request.redirect,
					signal: request.signal,
					...(request.body ? { duplex: "half" } : {}),
				} as RequestInit)
			: request;
		return app.fetch(actual, env, ctx);
	},

	async scheduled(_controller, env, ctx): Promise<void> {
		ctx.waitUntil(synchronize(env));
	},
} satisfies ExportedHandler<Env>;

export default handler;

export { authorized, parseRange } from "./http";

/**
 * `/v1` is the canonical interface version. Unversioned paths remain as
 * compatibility aliases for launcher builds that already shipped with them.
 */
function canonicalUrl(url: URL): URL | null {
	const pathname = url.pathname;
	let target: string | null = null;
	if (pathname === "/health" || pathname === "/releases") target = `/v1${pathname}`;
	else if (pathname.startsWith("/downloads/")) target = `/v1${pathname}`;
	else if (pathname === "/admin") target = "/v1/admin";
	else if (pathname.startsWith("/admin/")) target = `/v1${pathname}`;
	return target ? new URL(`${target}${url.search}`, url.origin) : null;
}

function requestMethod(request: Request): string {
	return ["GET", "HEAD", "POST", "OPTIONS"].includes(request.method)
		? request.method
		: "OTHER";
}
