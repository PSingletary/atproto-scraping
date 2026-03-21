import { glob } from 'node:fs/promises';

import type * as v from '@badrap/valita';
import { dequal } from 'dequal';

/** Read + validate a single entity file. Returns undefined if the file doesn't exist. */
export const readEntity = async <T>(path: string, schema: v.Type<T>): Promise<T | undefined> => {
	let raw: string;

	try {
		raw = await Deno.readTextFile(path);
	} catch {
		return undefined;
	}

	return schema.parse(JSON.parse(raw), { mode: 'passthrough' });
};

/** Read all entity files from a directory. Returns a Map of filename (without .json) → parsed entity. */
export const readEntityDir = async <T>(
	dir: string,
	schema: v.Type<T>,
): Promise<Map<string, T>> => {
	const entries: [string, T][] = [];

	for await (const relname of glob('*.json', { cwd: dir })) {
		const key = relname.replace(/\.json$/, '');
		const absname = `${dir}/${relname}`;

		const raw = await Deno.readTextFile(absname);
		const parsed = schema.parse(JSON.parse(raw), { mode: 'passthrough' });

		entries.push([key, parsed]);
	}

	entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

	return new Map(entries);
};

/** Write an entity file, only if the content has changed. */
export const writeEntity = async <T>(path: string, data: T, prev?: T): Promise<void> => {
	if (prev !== undefined && dequal(prev, data)) {
		return;
	}

	const json = JSON.stringify(data, null, '\t');
	await Deno.writeTextFile(path, json + '\n');
};

/** Remove an entity file. Silently succeeds if the file doesn't exist. */
export const removeEntity = async (path: string): Promise<void> => {
	try {
		await Deno.remove(path);
	} catch (err) {
		if (err instanceof Deno.errors.NotFound) {
			return;
		}
		throw err;
	}
};

/** Derive a filesystem-safe filename from a URL's host. */
export const hostFromUrl = (url: string): string => {
	return new URL(url).host;
};
