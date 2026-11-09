import type { Context } from "hono";

export interface Audit {
	route: string;
	tag: string;
	file: string;
	source: string;
}

export type Variables = {
	audit: Audit;
};

export type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
