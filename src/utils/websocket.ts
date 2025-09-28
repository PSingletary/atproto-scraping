import { WebSocket } from 'partysocket';

// deno-lint-ignore no-explicit-any
export const createWebSocketStream = <T = any>(url: string | URL) => {
	let ws: WebSocket | undefined;
	let closed = false;

	return new ReadableStream<T>({
		start(controller) {
			ws = new WebSocket(url.toString());
			closed = false;

			ws.onopen = () => {
				console.log('[ws] opened');
			};

			ws.onclose = () => {
				console.log('[ws] closed');
			};

			ws.onmessage = (ev) => {
				if (!closed) {
					controller.enqueue(JSON.parse(ev.data));
				}
			};
		},
		cancel() {
			closed = true;
			ws?.close();
		},
	});
};
