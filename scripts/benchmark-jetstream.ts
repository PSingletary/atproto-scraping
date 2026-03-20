const INSTANCES = [
	'wss://jetstream1.us-east.bsky.network',
	'wss://jetstream2.us-east.bsky.network',
	'wss://jetstream1.us-west.bsky.network',
	'wss://jetstream2.us-west.bsky.network',
	'wss://jetstream1.us-east.fire.hose.cam',
	'wss://jetstream2.fr.hose.cam',
	'wss://jetstream.fire.hose.cam',
];

/** How far back to set the replay cursor */
const CURSOR_OFFSET_US = 3 * 60 * 60 * 1_000_000;

/** Max wall-clock time per instance */
const BENCHMARK_DURATION_MS = 60_000;

/** Max time to wait for initial WebSocket connection */
const CONNECT_TIMEOUT_MS = 15_000;

interface BenchmarkResult {
	url: string;
	elapsed: number;
	eventCount: number;
	eventsPerSec: number;
	replayedSec: number;
	replayRatio: number;
	caughtUp: boolean;
	error: string | null;
}

function benchmarkInstance(url: string): Promise<BenchmarkResult> {
	const startCursor = Date.now() * 1_000 - CURSOR_OFFSET_US;
	const startTime = Date.now();

	let eventCount = 0;
	let lastCursor = startCursor;
	let caughtUp = false;

	return new Promise<BenchmarkResult>((resolve) => {
		const wsUrl = new URL('/subscribe', url);
		wsUrl.searchParams.set('requireHello', 'true');
		wsUrl.searchParams.set('cursor', String(startCursor));

		const ws = new WebSocket(wsUrl);
		let resolved = false;

		const finish = (error?: string) => {
			if (resolved) return;
			resolved = true;
			try {
				ws.close();
			} catch {
				/* noop */
			}

			const elapsed = (Date.now() - startTime) / 1_000;
			const replayedSec = (lastCursor - startCursor) / 1_000_000;

			resolve({
				url,
				elapsed: round(elapsed, 1),
				eventCount,
				eventsPerSec: round(eventCount / Math.max(elapsed, 0.1), 0),
				replayedSec: round(replayedSec, 0),
				replayRatio: round(replayedSec / Math.max(elapsed, 0.1), 1),
				caughtUp,
				error: error ?? null,
			});
		};

		const benchTimer = setTimeout(() => finish(), BENCHMARK_DURATION_MS);
		const connectTimer = setTimeout(() => finish('connection timeout'), CONNECT_TIMEOUT_MS);

		ws.onopen = () => {
			clearTimeout(connectTimer);

			// Filter to identity/account events only, matching export-dids usage
			ws.send(JSON.stringify({
				type: 'options_update',
				payload: { wantedCollections: [] },
			}));
		};

		ws.onmessage = (ev) => {
			try {
				const data = JSON.parse(String(ev.data));
				if (!data.time_us) return;

				eventCount++;
				lastCursor = data.time_us;

				if (lastCursor / 1_000 > Date.now() - 3_000) {
					caughtUp = true;
					clearTimeout(benchTimer);
					finish();
				}
			} catch {
				/* noop */
			}
		};

		ws.onerror = () => {
			clearTimeout(connectTimer);
			clearTimeout(benchTimer);
			finish('connection error');
		};

		ws.onclose = (ev) => {
			clearTimeout(connectTimer);
			clearTimeout(benchTimer);
			if (!resolved) {
				finish(ev.wasClean ? undefined : `closed: ${ev.code} ${ev.reason}`);
			}
		};
	});
}

function round(n: number, decimals: number): number {
	const factor = 10 ** decimals;
	return Math.round(n * factor) / factor;
}

function formatDuration(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	const m = Math.floor(seconds / 60);
	const s = Math.round(seconds % 60);
	if (m < 60) return `${m}m${s}s`;
	const h = Math.floor(m / 60);
	return `${h}h${m % 60}m`;
}

// Main
console.log('Jetstream replay benchmark');
console.log(`  cursor offset: ${CURSOR_OFFSET_US / 1_000_000 / 3600}h`);
console.log(`  max duration per instance: ${BENCHMARK_DURATION_MS / 1_000}s`);
console.log('');

const results: BenchmarkResult[] = [];

for (const url of INSTANCES) {
	const host = new URL(url).hostname;
	console.log(`benchmarking ${host}...`);

	const result = await benchmarkInstance(url);
	results.push(result);

	if (result.error) {
		console.log(`  error: ${result.error}`);
	} else {
		console.log(
			`  ${result.eventsPerSec} events/s, ${result.replayRatio}x replay ratio, ` +
				`${
					result.caughtUp
						? `caught up in ${result.elapsed}s`
						: `${formatDuration(result.replayedSec)} replayed`
				}`,
		);
	}
}

// Console summary
console.log('');

const col = (s: string, w: number) => s.padEnd(w);
const rcol = (s: string, w: number) => s.padStart(w);

const rows = results.map((r) => {
	const host = new URL(r.url).hostname;
	return {
		host,
		evtSec: r.error ? '-' : String(r.eventsPerSec),
		ratio: r.error ? '-' : `${r.replayRatio}x`,
		replayed: r.error ? '-' : formatDuration(r.replayedSec),
		caught: r.error ? '-' : r.caughtUp ? 'yes' : 'no',
		error: r.error ?? '',
	};
});

const W = { host: 38, evtSec: 10, ratio: 8, replayed: 10, caught: 9, error: 20 };

console.log(
	col('Instance', W.host) + rcol('Events/s', W.evtSec) + rcol('Ratio', W.ratio) +
		rcol('Replayed', W.replayed) + rcol('Caught up', W.caught) + '  Error',
);
console.log('-'.repeat(W.host + W.evtSec + W.ratio + W.replayed + W.caught + 2 + W.error));

for (const r of rows) {
	console.log(
		col(r.host, W.host) + rcol(r.evtSec, W.evtSec) + rcol(r.ratio, W.ratio) +
			rcol(r.replayed, W.replayed) + rcol(r.caught, W.caught) + '  ' + r.error,
	);
}

// GitHub Actions step summary
const summaryPath = Deno.env.get('GITHUB_STEP_SUMMARY');
if (summaryPath) {
	let md = '## Jetstream Replay Benchmark\n\n';
	md += `Cursor offset: ${CURSOR_OFFSET_US / 1_000_000 / 3600}h, `;
	md += `max ${BENCHMARK_DURATION_MS / 1_000}s per instance\n\n`;
	md += '| Instance | Events/s | Replay ratio | Replayed | Caught up | Error |\n';
	md += '|----------|----------|--------------|----------|-----------|-------|\n';

	for (const r of rows) {
		md += `| ${r.host} | ${r.evtSec} | ${r.ratio} | ${r.replayed} | ${r.caught} | ${r.error} |\n`;
	}

	await Deno.writeTextFile(summaryPath, md, { append: true });
}
