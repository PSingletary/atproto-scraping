import * as v from '@badrap/valita';
import * as tldts from 'tldts';

const isProperHostname = (hostname: string) => {
	const parsed = tldts.parse(hostname);
	if (!parsed.domain || !(parsed.isIcann || parsed.isIp)) {
		return false;
	}

	return true;
};

const serviceUrlString = v.string().chain((input) => {
	const url = URL.parse(input);

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
		return v.ok(url.toString());
	}

	return v.err(`must be a valid atproto service url`);
});

export const coerceAtprotoServiceEndpoint = (endpointUrl: string | undefined): string | undefined => {
	const result = serviceUrlString.try(endpointUrl);
	if (result.ok) {
		return result.value;
	}
};
