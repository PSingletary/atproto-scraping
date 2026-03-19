import { isHandle } from '@atcute/lexicons/syntax';
import * as tldts from 'tldts';

const isProperHostname = (hostname: string): boolean => {
	if (!isHandle(hostname)) {
		return false;
	}

	const parsed = tldts.parse(hostname);
	if (!parsed.domain || !(parsed.isIcann || parsed.isIp)) {
		return false;
	}

	return true;
};

/**
 * Validate and normalize an atproto service endpoint URL.
 * Returns the normalized URL string, or undefined if invalid.
 */
export const coerceServiceEndpoint = (endpointUrl: string | undefined): string | undefined => {
	if (endpointUrl === undefined) {
		return undefined;
	}

	const url = URL.parse(endpointUrl);

	if (
		url !== null &&
		url.protocol === 'https:' &&
		isProperHostname(url.hostname) &&
		url.pathname === '/' &&
		url.search === '' &&
		url.hash === '' &&
		url.port === '' &&
		url.username === '' &&
		url.password === ''
	) {
		return url.toString();
	}

	return undefined;
};
