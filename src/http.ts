import { ADMIN_PAGE } from "./adminPage";

export function json(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

export function adminPage(): Response {
	return new Response(ADMIN_PAGE, {
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			"X-Frame-Options": "DENY",
		},
	});
}

export function errorResponse(
	status: number,
	message: string,
	extra: Record<string, string> = {},
): Response {
	return new Response(message, {
		status,
		headers: { "Cache-Control": "no-store", ...extra },
	});
}

export function authorized(request: Request, secret?: string): boolean {
	if (!secret) return false;
	const supplied = request.headers.get("Authorization") ?? "";
	const expected = `Bearer ${secret}`;
	const encoder = new TextEncoder();
	if (supplied.length !== expected.length) return false;
	const suppliedBytes = encoder.encode(supplied);
	const expectedBytes = encoder.encode(expected);
	if (suppliedBytes.byteLength !== expectedBytes.byteLength) return false;
	return crypto.subtle.timingSafeEqual(suppliedBytes, expectedBytes);
}

export function parseRange(
	value: string,
	size: number,
): { offset: number; length: number } | false {
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
	if (
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(end) ||
		offset >= size ||
		end < offset
	)
		return false;
	return { offset, length: Math.min(end, size - 1) - offset + 1 };
}

export function conditions(
	request: Request,
	etag: string,
	modified: Date,
): number | null {
	const matches = (value: string, weak = false) =>
		value.split(",").some((item) => {
			const candidate = item.trim();
			return (
				candidate === "*" ||
				(weak ? candidate.replace(/^W\//, "") : candidate) === etag
			);
		});
	const ifMatch = request.headers.get("If-Match");
	if (ifMatch && !matches(ifMatch)) return 412;
	const unmodified = request.headers.get("If-Unmodified-Since");
	const seconds = Math.floor(modified.getTime() / 1000) * 1000;
	if (!ifMatch && unmodified && Date.parse(unmodified) < seconds) return 412;
	const noneMatch = request.headers.get("If-None-Match");
	if (noneMatch && matches(noneMatch, true)) return 304;
	const since = request.headers.get("If-Modified-Since");
	if (!noneMatch && since && Date.parse(since) >= seconds) return 304;
	return null;
}
