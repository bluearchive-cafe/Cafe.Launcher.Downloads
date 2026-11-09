import { OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { CATALOG_KEY, REPOSITORY, downloadPath, readJson, type MirrorRelease } from "../releases";
import type { AppContext } from "../types";

const MirrorFile = z.object({
	name: z.string(),
	size: z.number(),
	sha256: z.string(),
	assetId: z.number().optional(),
	url: z.string(),
});

const MirrorReleaseSchema = z.object({
	tag: z.string(),
	prerelease: z.boolean(),
	publishedAt: z.string(),
	mirroredAt: z.string(),
	files: MirrorFile.array(),
});

export class ReleaseCatalog extends OpenAPIRoute {
	schema = {
		tags: ["Releases"],
		summary: "List fully mirrored releases",
		description:
			"Lists only releases whose assets and checksum manifest finished verification. Download URLs are versioned relative paths.",
		responses: {
			"200": {
				description: "Verified release catalog",
				content: {
					"application/json": {
						schema: z.object({
							repository: z.string(),
							releases: MirrorReleaseSchema.array(),
						}),
					},
				},
			},
		},
	};

	async handle(c: AppContext) {
		c.get("audit").route = "catalog";
		const releases = (await readJson<MirrorRelease[]>(c.env.RELEASES, CATALOG_KEY)) ?? [];
		return {
			repository: REPOSITORY,
			releases: releases.map((release) => ({
				...release,
				files: release.files.map((file) => ({
					...file,
					url: downloadPath(release.tag, file.name),
				})),
			})),
		};
	}
}
