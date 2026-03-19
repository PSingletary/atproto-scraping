import { Client, ok, simpleFetchHandler } from '@atcute/client';
import * as DescribeServer from '@atcute/atproto/types/server/describeServer';
import * as QueryLabels from '@atcute/atproto/types/label/queryLabels';
import * as v from '@badrap/valita';

import { differenceInDays } from 'date-fns/differenceInDays';
import pmap from 'p-map';

import { DEFAULT_HEADERS, MAX_FAILURE_DAYS } from '../src/constants.ts';
import { type LabelerEntry, labelerSchema, type PDSEntry, pdsSchema } from '../src/state.ts';
import { hostFromUrl, readEntityDir, removeEntity, writeEntity } from '../src/io.ts';
import { jsonFetch } from '../src/utils/json-fetch.ts';

const now = Date.now();

const offHealthResponse = v.object({
	version: v.string().assert((input) => input.length <= 130),
});

// Load entities
const pdses = await readEntityDir('pdses', pdsSchema);
const labelers = await readEntityDir('labelers', labelerSchema);

// Check PDSes
console.log(`crawling known pdses`);

await pmap(Array.from(pdses.entries()), async ([host, entry]) => {
	const prev = structuredClone(entry);
	const client = new Client({ handler: simpleFetchHandler({ service: entry.url, fetch: jsonFetch }) });

	const start = performance.now();

	const meta = await ok(client.call(DescribeServer.mainSchema, {
		headers: DEFAULT_HEADERS,
	}))
		.then((data) => {
			if (data.did !== `did:web:${host}`) {
				throw new Error(`did mismatch`);
			}
			return data;
		})
		.catch(() => null);

	const end = performance.now();

	if (meta === null) {
		if (entry.errorAt === null) {
			entry.errorAt = now;
			if (entry.status === 'online') {
				entry.status = 'offline';
			}
		} else if (differenceInDays(now, entry.errorAt) > MAX_FAILURE_DAYS) {
			pdses.delete(host);
			await removeEntity(`pdses/${host}.json`);
			console.log(`  ${host}: removed (took ${end - start})`);
			return;
		}

		await writeEntity(`pdses/${host}.json`, entry, prev);

		console.log(`  ${host}: fail (took ${end - start})`);
		return;
	}

	const version = await getVersion(client, entry.version);

	entry.version = version;
	entry.inviteCodeRequired = meta.inviteCodeRequired;
	entry.errorAt = null;

	if (entry.status !== 'online') {
		entry.status = 'online';
	}

	await writeEntity(`pdses/${host}.json`, entry, prev);
	console.log(`  ${host}: pass (took ${end - start})`);
}, { concurrency: 8 });

// Check labelers
console.log(`crawling known labelers`);

await pmap(Array.from(labelers.entries()), async ([host, entry]) => {
	const prev = structuredClone(entry);
	const client = new Client({ handler: simpleFetchHandler({ service: entry.url, fetch: jsonFetch }) });

	const start = performance.now();

	const passed = await ok(client.call(QueryLabels.mainSchema, {
		headers: DEFAULT_HEADERS,
		params: { uriPatterns: ['*'], limit: 1 },
	}))
		.then(() => true)
		.catch(() => false);

	const end = performance.now();

	if (!passed) {
		if (entry.errorAt === null) {
			entry.errorAt = now;
			if (entry.status === 'online') {
				entry.status = 'offline';
			}
		} else if (differenceInDays(now, entry.errorAt) > MAX_FAILURE_DAYS) {
			labelers.delete(host);
			await removeEntity(`labelers/${host}.json`);
			console.log(`  ${host}: removed (took ${end - start})`);
			return;
		}

		await writeEntity(`labelers/${host}.json`, entry, prev);

		console.log(`  ${host}: fail (took ${end - start})`);
		return;
	}

	const version = await getVersion(client, entry.version);

	entry.version = version;
	entry.errorAt = null;

	if (entry.status !== 'online') {
		entry.status = 'online';
	}

	await writeEntity(`labelers/${host}.json`, entry, prev);
	console.log(`  ${host}: pass (took ${end - start})`);
}, { concurrency: 8 });

async function getVersion(client: Client, prev: string | null | undefined) {
	// skip if the response previously returned null (not official distrib)
	if (prev === null) {
		return null;
	}

	try {
		const response = await client.get('_health' as any, { headers: DEFAULT_HEADERS, as: 'json' });
		const { version } = offHealthResponse.parse(response.data as any, { mode: 'passthrough' });

		return /^[0-9a-f]{40}$/.test(version) ? `git-${version.slice(0, 7)}` : version;
	} catch {
		// _health not implemented
		return prev === undefined ? undefined : null;
	}
}
