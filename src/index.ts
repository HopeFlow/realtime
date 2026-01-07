import { DurableObject } from 'cloudflare:workers';
import { jwtVerify, type JWTPayload } from 'jose';

type Env = {
	JWT_SECRET: string;
	HOPEFLOW_REALTIME: DurableObjectNamespace;
};

type AuthPayload = JWTPayload & { userId: string };

type PublishInput = {
	userId?: unknown;
	type?: unknown;
	payload?: unknown;
};

type RealtimeEnvelope = {
	envelopeId: string;
	type: string;
	userId: string;
	timestamp: string;
	payload?: unknown;
};

type SubscriptionFilter = {
	type: string;
	[key: string]: string;
};

type AckMessage = {
	type: 'ack';
	envelopeId: string;
	result?: unknown;
};

type SubscribeMessage = {
	type: 'subscribe';
	filters: SubscriptionFilter[];
};

type UnsubscribeMessage = {
	type: 'unsubscribe';
	filters: SubscriptionFilter[];
};

const JSON_HEADERS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization,content-type',
	'access-control-allow-methods': 'POST,OPTIONS',
	'content-type': 'application/json; charset=utf-8',
} as const;

const encoder = new TextEncoder();
const HIBERNATION_TIMEOUT_MS = 60 * 60 * 1000;
const ACK_TIMEOUT_MS = 5000;

/* -------------------------- Durable Object (per user) -------------------------- */

export class HopeFlowRealtime extends DurableObject<Env> {
	private readonly subscriptions = new Map<WebSocket, SubscriptionFilter[]>();
	private readonly pendingAcks = new Map<
		string,
		{
			pending: Set<WebSocket>;
			results: unknown[];
			resolve: (results: unknown[]) => void;
			timeout: number;
		}
	>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const userId = (request.headers.get('x-user-id') || '').trim();
		if (!userId) {
			console.warn('request missing x-user-id header');
			return new Response('Unauthorized', { status: 401 });
		}

		// Outer worker already authenticated and sharded to the correct DO.
		// We only handle:
		//   - WS /connect   (outer worker adds X-User-ID)
		//   - POST /deliver (outer worker sends canonical RealtimeEnvelope JSON)
		if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket' && url.pathname === '/connect') {
			return this.handleConnect(request);
		}

		if (request.method === 'POST' && url.pathname === '/deliver') {
			return this.handleDeliver(request);
		}

		if (request.method === 'OPTIONS' && url.pathname === '/deliver') {
			return this.corsPreflight();
		}

		return new Response('Not Found', { status: 404 });
	}

	private async handleConnect(request: Request): Promise<Response> {
		const userId = (request.headers.get('x-user-id') || '').trim();

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		// With one DO per user, tags are optional. Keep one for possible subtopics later.
		const tag = `user:${userId}`;

		this.ctx.setHibernatableWebSocketEventTimeout(HIBERNATION_TIMEOUT_MS);
		this.ctx.acceptWebSocket(server, [tag]);

		// Assign a unique connection ID to the attachment
		const connectionId = crypto.randomUUID();
		server.serializeAttachment({ userId, connectionId });

		return new Response(null, { status: 101, webSocket: client });
	}

	private async handleDeliver(request: Request): Promise<Response> {
		// CORS handled here because outer worker might call this from browser contexts.
		const contentType = request.headers.get('content-type') ?? '';
		if (!contentType.toLowerCase().includes('application/json')) {
			return this.json({ error: 'Unsupported Media Type' }, 415);
		}

		let envelope: RealtimeEnvelope;
		try {
			const parsed = (await request.json()) as unknown;
			const normalized = this.normalizeEnvelope(parsed);
			if (!normalized) return this.json({ error: 'Invalid envelope' }, 400);
			envelope = normalized;
			if (!envelope.envelopeId) {
				envelope.envelopeId = generateEnvelopeId();
			}
		} catch {
			return this.json({ error: 'Invalid JSON body' }, 400);
		}

		const sockets = this.ctx.getWebSockets();
		const targets: WebSocket[] = [];

		for (const socket of sockets) {
			await this.restoreSubscriptionsIfMissing(socket);
			if (this.shouldDeliver(socket, envelope)) {
				targets.push(socket);
			}
		}

		if (targets.length === 0) {
			return this.json({ clientCount: 0, results: [] });
		}

		const serialized = JSON.stringify(envelope);
		const ackPromise = this.awaitAcks(envelope.envelopeId, targets);

		for (const socket of targets) {
			try {
				socket.send(serialized);
			} catch (error) {
				console.error('failed to deliver realtime message', { error });
				this.removeFromPending(envelope.envelopeId, socket);
				try {
					socket.close(1011, 'delivery failure');
				} catch (closeError) {
					console.error('failed to close websocket after delivery error', { closeError });
				}
			}
		}

		const results = await ackPromise;
		return this.json({ clientCount: targets.length, results });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const ctx = this.getConnectionContext(ws);
		if (!ctx) {
			ws.close(1008, 'missing session');
			return;
		}
		if (typeof message === 'string') {
			const trimmed = message.trim().toLowerCase();
			if (trimmed === 'ping') {
				ws.send('pong');
				return;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(message);
			} catch {
				return;
			}

			if (!parsed || typeof parsed !== 'object') return;
			const typed = parsed as { type?: unknown };
			if (typed.type === 'ack') {
				this.handleAck(ws, parsed as AckMessage);
			} else if (typed.type === 'subscribe') {
				await this.handleSubscribe(ws, parsed as SubscribeMessage);
			} else if (typed.type === 'unsubscribe') {
				await this.handleUnsubscribe(ws, parsed as UnsubscribeMessage);
			}
		}
	}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		const ctx = this.getConnectionContext(ws);
		if (!ctx) return;
		this.subscriptions.delete(ws);
		// Cleanup storage
		if (ctx.connectionId) {
			await this.ctx.storage.delete(`sub:${ctx.connectionId}`);
		}
		for (const [envelopeId, entry] of this.pendingAcks.entries()) {
			if (entry.pending.delete(ws) && entry.pending.size === 0) {
				this.finishPending(envelopeId, entry);
			}
		}
		if (code !== 1000) {
			console.warn('websocket closed abnormally', { userId: ctx.userId, code });
		}
	}

	private getConnectionContext(ws: WebSocket): { userId: string; connectionId?: string } | null {
		const attachment = ws.deserializeAttachment();
		if (attachment && typeof (attachment as { userId?: unknown }).userId === 'string') {
			return attachment as { userId: string; connectionId?: string };
		}
		return null;
	}

	private shouldDeliver(socket: WebSocket, envelope: RealtimeEnvelope): boolean {
		const filters = this.subscriptions.get(socket);
		if (!filters || filters.length === 0) return false;
		return filters.some((filter) => this.matchesEnvelope(filter, envelope));
	}

	private matchesEnvelope(filter: SubscriptionFilter, envelope: RealtimeEnvelope): boolean {
		if (filter.type !== envelope.type) return false;
		const payload = envelope.payload;
		if (Object.keys(filter).length === 1) return true;
		if (!payload || typeof payload !== 'object') return false;
		const payloadObj = payload as Record<string, unknown>;
		for (const [key, value] of Object.entries(filter)) {
			if (key === 'type') continue;
			if (payloadObj[key] !== value) return false;
		}
		return true;
	}

	private normalizeEnvelope(raw: unknown): Exclude<RealtimeEnvelope, 'envelopeId'> | null {
		if (!raw || typeof raw !== 'object') return null;
		const obj = raw as Record<string, unknown>;
		const envelopeId = typeof obj.envelopeId === 'string' ? obj.envelopeId.trim() : '';
		const type = typeof obj.type === 'string' ? obj.type.trim() : '';
		const userId = typeof obj.userId === 'string' ? obj.userId.trim() : '';
		const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp.trim() : '';
		if (Number.isNaN(Date.parse(timestamp))) return null;
		return {
			envelopeId,
			type,
			userId,
			timestamp,
			...(obj.payload !== undefined ? { payload: obj.payload } : {}),
		};
	}

	private awaitAcks(envelopeId: string, sockets: WebSocket[]): Promise<unknown[]> {
		if (sockets.length === 0) return Promise.resolve([]);
		return new Promise((resolve) => {
			const pending = new Set(sockets);
			const entry = {
				pending,
				results: [] as unknown[],
				resolve,
				timeout: 0 as unknown as number,
			};
			entry.timeout = setTimeout(() => {
				if (!this.pendingAcks.has(envelopeId)) return;
				this.pendingAcks.delete(envelopeId);
				resolve(entry.results);
			}, ACK_TIMEOUT_MS) as unknown as number;
			this.pendingAcks.set(envelopeId, entry);
		});
	}

	private removeFromPending(envelopeId: string, socket: WebSocket): void {
		const entry = this.pendingAcks.get(envelopeId);
		if (!entry) return;
		entry.pending.delete(socket);
		if (entry.pending.size === 0) {
			this.finishPending(envelopeId, entry);
		}
	}

	private finishPending(
		envelopeId: string,
		entry: { pending: Set<WebSocket>; results: unknown[]; resolve: (results: unknown[]) => void; timeout: number }
	) {
		clearTimeout(entry.timeout);
		this.pendingAcks.delete(envelopeId);
		entry.resolve(entry.results);
	}

	private handleAck(ws: WebSocket, msg: AckMessage): void {
		if (!msg.envelopeId || typeof msg.envelopeId !== 'string') return;
		const entry = this.pendingAcks.get(msg.envelopeId);
		if (!entry) return;
		if (!entry.pending.delete(ws)) return;
		entry.results.push('result' in msg ? msg.result : null);
		if (entry.pending.size === 0) {
			this.finishPending(msg.envelopeId, entry);
		}
	}

	private async handleSubscribe(ws: WebSocket, msg: SubscribeMessage): Promise<void> {
		const incoming = this.normalizeFilters(msg.filters);
		if (incoming.length === 0) return;
		const existing = this.subscriptions.get(ws) ?? [];
		const merged = [...existing];
		for (const filter of incoming) {
			if (!merged.some((f) => this.filtersEqual(f, filter))) {
				merged.push(filter);
			}
		}
		this.subscriptions.set(ws, merged);
		await this.persistSubscriptions(ws, merged);
	}

	private async handleUnsubscribe(ws: WebSocket, msg: UnsubscribeMessage): Promise<void> {
		const toRemove = this.normalizeFilters(msg.filters);
		if (toRemove.length === 0) return;
		const existing = this.subscriptions.get(ws) ?? [];
		const remaining = existing.filter((f) => !toRemove.some((r) => this.filtersEqual(f, r)));
		this.subscriptions.set(ws, remaining);
		await this.persistSubscriptions(ws, remaining);
	}

	private async persistSubscriptions(ws: WebSocket, filters: SubscriptionFilter[]): Promise<void> {
		const ctx = this.getConnectionContext(ws);
		if (ctx?.connectionId) {
			await this.ctx.storage.put(`sub:${ctx.connectionId}`, filters);
		}
	}

	private async restoreSubscriptionsIfMissing(ws: WebSocket): Promise<void> {
		if (this.subscriptions.has(ws)) return;
		const ctx = this.getConnectionContext(ws);
		if (ctx?.connectionId) {
			const filters = (await this.ctx.storage.get<SubscriptionFilter[]>(`sub:${ctx.connectionId}`)) ?? [];
			this.subscriptions.set(ws, filters);
		}
	}

	private normalizeFilters(raw: unknown): SubscriptionFilter[] {
		if (!Array.isArray(raw)) return [];
		const normalized: SubscriptionFilter[] = [];
		for (const candidate of raw.slice(0, 50)) {
			if (!candidate || typeof candidate !== 'object') continue;
			const obj = candidate as Record<string, unknown>;
			const type = typeof obj.type === 'string' ? obj.type.trim() : '';
			if (!type) continue;
			const filter: SubscriptionFilter = { type };
			let valid = true;
			for (const [key, value] of Object.entries(obj)) {
				if (key === 'type') continue;
				if (typeof value !== 'string') {
					valid = false;
					break;
				}
				filter[key] = value;
			}
			if (valid) normalized.push(filter);
		}
		return normalized;
	}

	private filtersEqual(a: SubscriptionFilter, b: SubscriptionFilter): boolean {
		const keysA = Object.keys(a).sort();
		const keysB = Object.keys(b).sort();
		if (keysA.length !== keysB.length) return false;
		for (let i = 0; i < keysA.length; i++) {
			const key = keysA[i];
			if (key !== keysB[i]) return false;
			if (a[key] !== b[key]) return false;
		}
		return true;
	}

	private corsPreflight(): Response {
		return new Response(null, {
			status: 204,
			headers: {
				'access-control-allow-origin': JSON_HEADERS['access-control-allow-origin'],
				'access-control-allow-headers': JSON_HEADERS['access-control-allow-headers'],
				'access-control-allow-methods': JSON_HEADERS['access-control-allow-methods'],
				'access-control-max-age': '86400',
			},
		});
	}

	private json(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: JSON_HEADERS,
		});
	}
}

/* ------------------------------ Outer Worker ------------------------------ */

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const method = request.method;

		// CORS preflight for /publish (browser clients)
		if (method === 'OPTIONS' && url.pathname === '/publish') {
			return new Response(null, {
				status: 204,
				headers: {
					'access-control-allow-origin': JSON_HEADERS['access-control-allow-origin'],
					'access-control-allow-headers': JSON_HEADERS['access-control-allow-headers'],
					'access-control-allow-methods': JSON_HEADERS['access-control-allow-methods'],
					'access-control-max-age': '86400',
				},
			});
		}

		// WebSocket upgrade → authenticate here, then forward to the user's DO
		if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
			const auth = await authenticate(request.headers.get('Authorization'), env.JWT_SECRET, url.searchParams.get('token'));
			if (!auth) {
				console.warn('unauthorized websocket connection attempt');
				return new Response('Unauthorized', { status: 401 });
			}

			const userId = auth.userId.trim();
			if (!userId) {
				console.warn('websocket connection attempt with empty userId in token');
				return new Response('Unauthorized', { status: 401 });
			}

			const stub = stubForUser(env, userId);

			// Forward the upgrade with an added X-User-ID header (no need to re-verify in DO)
			const forwarded = withAddedHeader(request, 'x-user-id', userId, '/connect');
			return stub.fetch(forwarded);
		}

		// Process publish entirely here; send canonical envelope to the user's DO
		if (method === 'POST' && url.pathname === '/publish') {
			const auth = await authenticate(request.headers.get('Authorization'), env.JWT_SECRET, url.searchParams.get('token'));
			if (!auth) {
				console.warn('unauthorized publish attempt');
				return json({ error: 'Unauthorized' }, 401);
			}

			const contentType = request.headers.get('content-type') ?? '';
			if (!contentType.toLowerCase().includes('application/json')) {
				return json({ error: 'Unsupported Media Type' }, 415);
			}

			let body: PublishInput;
			try {
				body = (await request.json()) as PublishInput;
			} catch {
				return json({ error: 'Invalid JSON body' }, 400);
			}

			const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
			if (!userId) return json({ error: 'userId is required' }, 400);

			const type = typeof body.type === 'string' && body.type.trim().length > 0 ? body.type.trim() : 'message';

			const envelope: RealtimeEnvelope = {
				envelopeId: generateEnvelopeId(),
				type,
				userId,
				timestamp: new Date().toISOString(),
				...(body.payload !== undefined ? { payload: body.payload } : {}),
			};

			const stub = stubForUser(env, userId);

			const deliverReq = new Request(new URL('/deliver', request.url), {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-user-id': userId },
				body: JSON.stringify(envelope),
			});

			return stub.fetch(deliverReq);
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

/* ------------------------------ Helpers ------------------------------ */

function stubForUser(env: Env, userId: string) {
	const name = `user:${userId}`;
	const id = env.HOPEFLOW_REALTIME.idFromName(name);
	return env.HOPEFLOW_REALTIME.get(id);
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: JSON_HEADERS,
	});
}

async function authenticate(header: string | null, secret: string, queryToken?: string | null): Promise<AuthPayload | null> {
	const token = extractToken(header) ?? sanitizeQueryToken(queryToken);
	if (!token) return null;
	try {
		const key = encoder.encode(secret);
		const { payload } = await jwtVerify<AuthPayload>(token, key, { algorithms: ['HS256'], typ: 'JWT' });
		if (typeof payload.userId !== 'string' || payload.userId.trim().length === 0) return null;
		return payload;
	} catch (err) {
		console.warn('jwt verification failed', err);
		return null;
	}
}

function extractToken(header: string | null): string | null {
	if (!header) return null;
	const trimmed = header.trim();
	if (!trimmed) return null;
	if (trimmed.toLowerCase().startsWith('bearer ')) {
		const bearer = trimmed.slice(7).trim();
		return bearer.length > 0 ? bearer : null;
	}
	return trimmed;
}

function sanitizeQueryToken(token: string | null | undefined): string | null {
	if (!token) return null;
	const trimmed = token.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function generateEnvelopeId(): string {
	if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
		return crypto.randomUUID();
	}
	return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Clone a Request, optionally change path, and add a header
function withAddedHeader(orig: Request, headerName: string, headerValue: string, newPath?: string) {
	const url = new URL(orig.url);
	if (newPath) url.pathname = newPath;

	const headers = new Headers(orig.headers);
	headers.set(headerName, headerValue);
	// It’s fine to keep (or drop) Authorization; we drop it since we already authenticated.
	headers.delete('authorization');

	return new Request(url.toString(), {
		method: orig.method,
		headers,
		body: orig.body, // safe for upgrade (null), or for simple POSTs we don’t use this function
		redirect: orig.redirect,
	});
}
