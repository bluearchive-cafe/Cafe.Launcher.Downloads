import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import type { AppContext } from "../types";

export class Health extends OpenAPIRoute {
	schema = {
		tags: ["Service"],
		summary: "Process health check",
		description:
			"Reports that the Worker is running. It does not indicate that a release has finished mirroring.",
		responses: {
			"200": {
				description: "The Worker is running",
				content: {
					"application/json": {
						schema: z.object({
							service: z.string(),
							status: z.string(),
						}),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		c.get("audit").route = "health";
		return { service: "cafe-launcher-downloads", status: "ok" };
	}
}
