import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { json } from "../http";
import { STATUS_KEY, readJson } from "../releases";
import { readStatistics } from "../statistics";
import { synchronize } from "../sync";
import type { AppContext } from "../types";

export class AdminStatus extends OpenAPIRoute {
	schema = {
		tags: ["Administration"],
		summary: "Read the last synchronization status",
		responses: {
			"200": {
				description: "Last sync state, or not_started",
				content: {
					"application/json": { schema: z.record(z.string(), z.unknown()) },
				},
			},
			"401": { description: "Administrator credentials required" },
		},
	};

	async handle(c: AppContext) {
		return json((await readJson(c.env.RELEASES, STATUS_KEY)) ?? { state: "not_started" });
	}
}

export class AdminStats extends OpenAPIRoute {
	schema = {
		tags: ["Administration"],
		summary: "Read 30-day download statistics",
		responses: {
			"200": {
				description: "Aggregated traffic statistics for the last 30 UTC days",
				content: {
					"application/json": { schema: z.record(z.string(), z.unknown()) },
				},
			},
			"401": { description: "Administrator credentials required" },
		},
	};

	async handle(c: AppContext) {
		return json(await readStatistics(c.env.STATS));
	}
}

export class AdminSync extends OpenAPIRoute {
	schema = {
		tags: ["Administration"],
		summary: "Run one bounded synchronization batch",
		description:
			"Keeps the HTTP request connected until the bounded batch finishes. Large releases may need several batches.",
		responses: {
			"200": {
				description: "Batch finished",
				content: {
					"application/json": { schema: z.record(z.string(), z.unknown()) },
				},
			},
			"401": { description: "Administrator credentials required" },
			"409": { description: "Another synchronization holds the lease" },
			"502": { description: "One or more release errors were reported" },
		},
	};

	async handle(c: AppContext) {
		const result = await synchronize(c.env);
		return json(
			result,
			result.locked ? 409 : result.errors.length ? 502 : 200,
		);
	}
}
