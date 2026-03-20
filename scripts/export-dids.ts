import { glob } from 'node:fs/promises';

import { getLabelerEndpoint, getPdsEndpoint } from '@atcute/identity';
import { AtprotoWebDidDocumentResolver } from '@atcute/identity-resolver';
import { JetstreamSubscription } from '@atcute/jetstream';

import { differenceInDays } from 'date-fns/differenceInDays';
import pmap from 'p-map';

import {
	type CursorState,
	cursorState,
	type IdentityEntry,
	identitySchema,
	type LabelerEntry,
	labelerSchema,
	type PDSEntry,
	pdsSchema,
} from '../src/state.ts';

import {
	DEFAULT_HEADERS,
	DID_WEB_EXCLUSIONS_RE,
	EXCLUSIONS_RE,
	JETSTREAM_URL,
	MAX_FAILURE_DAYS,
	PLC_URL,
} from '../src/constants.ts';
import { coerceServiceEndpoint } from '../src/utils/did.ts';
import { hostFromUrl, readEntityDir, writeEntity } from '../src/io.ts';
import { LineBreakStream } from '../src/utils/stream.ts';

const now = Date.now();

const STATE_FILE = 'state.json';

// Read cursor state
let state: CursorState | undefined;
{
	try {
		const source = await Deno.readTextFile(STATE_FILE);
		state = cursorState.parse(JSON.parse(source));
	} catch {
		/* empty */
	}
}

let plcCursor = state?.plc.cursor;
let firehoseCursor = state?.firehose.cursor;

// Load existing entities into memory
const pdses = await readEntityDir('pdses', pdsSchema);
const labelers = await readEntityDir('labelers', labelerSchema);
const identities = await readEntityDir('identities', identitySchema);

// Helper: ensure a PDS is tracked
const trackPds = (url: string) => {
	if (EXCLUSIONS_RE.test(url)) {
		return;
	}

	const host = hostFromUrl(url);
	const existing = pdses.get(host);

	if (existing === undefined) {
		console.log(`  found pds: ${url}`);

		const entry: PDSEntry = {
			url,
			status: 'unreachable',
			firstSeenAt: now,
			errorAt: null,
		};

		pdses.set(host, entry);
	} else if (existing.errorAt !== null) {
		console.log(`  found pds: ${url} (errored, resetting)`);
		existing.errorAt = null;
	}
};

// Helper: ensure a labeler is tracked
const trackLabeler = (url: string, did: string) => {
	if (EXCLUSIONS_RE.test(url)) {
		return;
	}

	const host = hostFromUrl(url);
	const existing = labelers.get(host);

	if (existing === undefined) {
		console.log(`  found labeler: ${url}`);

		const entry: LabelerEntry = {
			url,
			did,
			status: 'unreachable',
			firstSeenAt: now,
			errorAt: null,
		};

		labelers.set(host, entry);
	} else {
		if (existing.errorAt !== null) {
			console.log(`  found labeler: ${url} (errored, resetting)`);
			existing.errorAt = null;
		}
		existing.did = did;
	}
};

// Iterate through PLC events
{
	const limit = 1000;
	let after: string | undefined = plcCursor;

	console.log(`crawling plc.directory`);
	console.log(`  starting ${plcCursor || '<root>'}`);

	do {
		const url = `${PLC_URL}/export` + `?count=${limit}` + (after ? `&after=${after}` : '');

		const response = await get(url);
		const stream = response.body!.pipeThrough(new TextDecoderStream()).pipeThrough(new LineBreakStream());

		after = undefined;

		let count = 0;

		for await (const raw of stream) {
			const json = JSON.parse(raw) as ExportEntry;
			const { did, operation, createdAt } = json;

			if (operation.type === 'plc_operation') {
				const pds = coerceServiceEndpoint(operation.services.atproto_pds?.endpoint);
				const labeler = coerceServiceEndpoint(operation.services.atproto_labeler?.endpoint);

				if (pds) {
					trackPds(pds);
				}

				if (labeler) {
					trackLabeler(labeler, did);
				}
			}

			count++;
			after = createdAt;
		}

		if (after) {
			plcCursor = after;
		}

		if (count < limit) {
			break;
		}
	} while (after !== undefined);

	console.log(`  ending ${plcCursor || '<root>'}`);

	interface ExportEntry {
		did: string;
		operation: PlcOperation;
		cid: string;
		nullified: boolean;
		createdAt: string;
	}

	type PlcOperation = LegacyGenesisOp | OperationOp | TombstoneOp;

	interface OperationOp {
		type: 'plc_operation';
		rotationKeys: string[];
		verificationMethods: Record<string, string>;
		alsoKnownAs: string[];
		services: Record<string, Service | undefined>;
		prev: string | null;
		sig: string;
	}

	interface TombstoneOp {
		type: 'plc_tombstone';
		prev: string;
		sig: string;
	}

	interface LegacyGenesisOp {
		type: 'create';
		signingKey: string;
		recoveryKey: string;
		handle: string;
		service: string;
		prev: string | null;
		sig: string;
	}

	interface Service {
		type: string;
		endpoint: string;
	}
}

// Watch the relay to find any did:web identities
{
	// run it 5 seconds back
	const cursor = Math.max(0, (firehoseCursor ?? 0) - 5 * 1_000_000);

	console.log(`listening to relay`);
	console.log(`  connecting to ${JETSTREAM_URL}`);
	console.log(`  starting ${cursor || '<root>'}`);

	const subscription = new JetstreamSubscription({
		url: JETSTREAM_URL,
		cursor: cursor,
		wantedCollections: [],
		validateEvents: false,
	});

	let throttled = false;

	for await (const event of subscription) {
		const eventCursor = event.time_us;

		if (eventCursor / 1_000_000 > Date.now() / 1_000 - 3) {
			break;
		}

		if (!throttled) {
			throttled = true;
			Deno.unrefTimer(setTimeout(() => (throttled = false), 60_000));

			console.log(`  at ${new Date(eventCursor / 1_000).toISOString()}`);
		}

		const kind = event.kind;
		if (kind === 'account' || kind === 'identity') {
			const did = event.did;

			if (did.startsWith('did:web:')) {
				if (DID_WEB_EXCLUSIONS_RE.test(did)) {
					continue;
				}

				const host = did.slice(8);
				const existing = identities.get(host);

				if (existing === undefined) {
					console.log(`  found ${did}`);

					const entry: IdentityEntry = {
						did,
						status: 'unreachable',
						firstSeenAt: now,
						errorAt: null,
					};

					identities.set(host, entry);
				} else if (existing.errorAt !== null) {
					console.log(`  found ${did} (errored, resetting)`);
					existing.errorAt = null;
				}
			}
		}
	}

	firehoseCursor = subscription.cursor;
	console.log(`  ending ${firehoseCursor || '<root>'}`);
}

// Retrieve PDS information from known did:web identities
{
	const resolver = new AtprotoWebDidDocumentResolver();

	console.log(`crawling known did:web identities`);

	await pmap(Array.from(identities.entries()), async ([host, entry]) => {
		const did = entry.did;

		try {
			const doc = await resolver.resolve(did as `did:web:${string}`, {
				signal: AbortSignal.timeout(10_000),
			});

			if (doc.id !== did) {
				throw new Error(`did mismatch (got ${doc.id})`);
			}

			const text = JSON.stringify(doc);
			const sha256sum = await getSha256Hash(text);

			if (entry.hash !== sha256sum) {
				const pds = coerceServiceEndpoint(getPdsEndpoint(doc));
				const labeler = coerceServiceEndpoint(getLabelerEndpoint(doc));

				console.log(`  ${did}: pass (updated)`);

				if (pds) {
					trackPds(pds);
				}

				if (labeler) {
					trackLabeler(labeler, did);
				}

				entry.hash = sha256sum;
				entry.pds = pds ?? null;
				entry.labeler = labeler ?? null;
			} else {
				console.log(`  ${did}: pass`);
			}

			entry.errorAt = null;

			if (entry.status === 'unreachable') {
				entry.status = 'online';
			}
		} catch (err) {
			if (entry.errorAt === null) {
				entry.errorAt = now;
				if (entry.status === 'online') {
					entry.status = 'offline';
				}
			} else if (differenceInDays(now, entry.errorAt) > MAX_FAILURE_DAYS) {
				identities.delete(host);
			}

			console.log(`  ${did}: fail (${err})`);
		}
	}, { concurrency: 8 });
}

// Persist entity files
{
	console.log(`writing entity files`);

	for (const [host, entry] of pdses) {
		await writeEntity(`pdses/${host}.json`, entry);
	}

	for (const [host, entry] of labelers) {
		await writeEntity(`labelers/${host}.json`, entry);
	}

	for (const [host, entry] of identities) {
		await writeEntity(`identities/${host}.json`, entry);
	}

	// Clean up deleted identity files
	for await (const relname of glob('*.json', { cwd: 'identities' })) {
		const key = relname.replace(/\.json$/, '');
		if (!identities.has(key)) {
			await Deno.remove(`identities/${relname}`);
		}
	}
}

// Persist cursor state
{
	const cursors: CursorState = {
		plc: { cursor: plcCursor },
		firehose: { cursor: firehoseCursor },
	};

	await Deno.writeTextFile(STATE_FILE, JSON.stringify(cursors, null, '\t') + '\n');
}

async function get(url: string, signal?: AbortSignal): Promise<Response> {
	const response = await fetch(url, { signal, headers: DEFAULT_HEADERS });

	if (response.status === 429) {
		const delay = 90_000;

		console.log(`[-] ratelimited, waiting ${delay} ms`);

		await sleep(delay);
		return get(url, signal);
	}

	if (!response.ok) {
		throw new Error(`got ${response.status} from ${url}`);
	}

	return response;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSha256Hash(data: string) {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(data);

	const hash = await crypto.subtle.digest('SHA-256', bytes);

	return toBase64Url(new Uint8Array(hash));
}

function toBase64Url(array: Uint8Array) {
	const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	const len = array.length;

	let result = '';
	let idx = 0;
	let triplet: number;

	const at = (shift: number): string => {
		return BASE64_ALPHABET[(triplet >> (6 * shift)) & 63];
	};

	for (; idx + 2 < len; idx += 3) {
		triplet = (array[idx] << 16) + (array[idx + 1] << 8) + array[idx + 2];
		result += at(3) + at(2) + at(1) + at(0);
	}

	if (idx + 2 === len) {
		triplet = (array[idx] << 16) + (array[idx + 1] << 8);
		result += at(3) + at(2) + at(1);
	} else if (idx + 1 === len) {
		triplet = array[idx] << 16;
		result += at(3) + at(2);
	}

	return result;
}
