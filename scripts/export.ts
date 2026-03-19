import { identitySchema, labelerSchema, pdsSchema } from '../src/state.ts';
import { readEntityDir } from '../src/io.ts';

import { dequal } from 'dequal';

const EXPORT_FILE = 'dist/instances.json';

const pdses = await readEntityDir('pdses', pdsSchema);
const labelers = await readEntityDir('labelers', labelerSchema);
const identities = await readEntityDir('identities', identitySchema);

// Build export object
const exported: Record<string, unknown> = {
	generatedAt: new Date().toISOString(),
	pdses: {} as Record<string, unknown>,
	labelers: {} as Record<string, unknown>,
	identities: {} as Record<string, unknown>,
};

for (const [_host, entry] of pdses) {
	(exported.pdses as Record<string, unknown>)[entry.url] = {
		status: entry.status,
		version: entry.version ?? null,
		inviteCodeRequired: entry.inviteCodeRequired ?? null,
	};
}

for (const [_host, entry] of labelers) {
	(exported.labelers as Record<string, unknown>)[entry.url] = {
		did: entry.did,
		status: entry.status,
		version: entry.version ?? null,
	};
}

for (const [_host, entry] of identities) {
	(exported.identities as Record<string, unknown>)[entry.did] = {
		status: entry.status,
		pds: entry.pds ?? null,
		labeler: entry.labeler ?? null,
	};
}

// Only write if changed (ignoring generatedAt)
let shouldWrite = true;
try {
	const source = await Deno.readTextFile(EXPORT_FILE);
	const existing = JSON.parse(source);

	const { generatedAt: _a, ...existingRest } = existing;
	const { generatedAt: _b, ...exportedRest } = exported;

	if (dequal(existingRest, exportedRest)) {
		shouldWrite = false;
	}
} catch {
	/* empty */
}

if (shouldWrite) {
	await Deno.writeTextFile(EXPORT_FILE, JSON.stringify(exported, null, '\t') + '\n');
	console.log(`wrote to ${EXPORT_FILE}`);
} else {
	console.log(`writing skipped`);
}
