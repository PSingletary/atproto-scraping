import * as v from '@badrap/valita';

const dateInt = v.number().chain((value) => {
	const date = new Date(value);
	const ts = date.getTime();

	if (Number.isNaN(ts)) {
		return v.err(`invalid date`);
	}

	return v.ok(ts);
});

const status = v.union(v.literal('online'), v.literal('offline'), v.literal('unreachable'));

export type EntityStatus = v.Infer<typeof status>;

// Per-entity schemas

export const pdsSchema = v.object({
	url: v.string(),
	status: status,
	version: v.string().nullable().optional(),
	inviteCodeRequired: v.boolean().optional(),
	firstSeenAt: dateInt,

	errorAt: dateInt.nullable(),
});

export type PDSEntry = v.Infer<typeof pdsSchema>;

export const labelerSchema = v.object({
	url: v.string(),
	did: v.string(),
	status: status,
	version: v.string().nullable().optional(),
	firstSeenAt: dateInt,

	errorAt: dateInt.nullable(),
});

export type LabelerEntry = v.Infer<typeof labelerSchema>;

export const identitySchema = v.object({
	did: v.string(),
	status: status,
	hash: v.string().optional(),
	pds: v.string().nullable().optional(),
	labeler: v.string().nullable().optional(),
	firstSeenAt: dateInt,

	errorAt: dateInt.nullable(),
});

export type IdentityEntry = v.Infer<typeof identitySchema>;

// Cursor-only state (persisted in state.json)

export const cursorState = v.object({
	plc: v.object({
		cursor: v.string().optional(),
	}),
	firehose: v.object({
		cursor: v.number().optional(),
	}),
});

export type CursorState = v.Infer<typeof cursorState>;
