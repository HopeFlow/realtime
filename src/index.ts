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
	type: string;
	userId: string;
	timestamp: string;
	payload?: unknown;
};

const JSON_HEADERS = {
	'access-control-allow-origin': '*',
	'access-control-allow-headers': 'authorization,content-type',
	'access-control-allow-methods': 'POST,OPTIONS',
	'content-type': 'application/json; charset=utf-8',
} as const;

const encoder = new TextEncoder();
const HIBERNATION_TIMEOUT_MS = 60 * 60 * 1000;

/* -------------------------- Durable Object (per user) -------------------------- */

export class HopeFlowRealtime extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

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
		if (!userId) return new Response('Unauthorized', { status: 401 });

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		// With one DO per user, tags are optional. Keep one for possible subtopics later.
		const tag = `user:${userId}`;

		this.ctx.setHibernatableWebSocketEventTimeout(HIBERNATION_TIMEOUT_MS);
		this.ctx.acceptWebSocket(server, [tag]);

		server.serializeAttachment({ userId });
		server.accept();

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
			envelope = (await request.json()) as RealtimeEnvelope;
		} catch {
			return this.json({ error: 'Invalid JSON body' }, 400);
		}

		// Fan-out to all sockets in this DO (all belong to the same user).
		const serialized = JSON.stringify(envelope);
		const sockets = this.ctx.getWebSockets(); // no tag needed with per-user DO

		let delivered = 0;
		for (const socket of sockets) {
			try {
				socket.accept();
				socket.send(serialized);
				delivered += 1;
			} catch (error) {
				console.error('failed to deliver realtime message', { error });
				try {
					socket.close(1011, 'delivery failure');
				} catch (closeError) {
					console.error('failed to close websocket after delivery error', { closeError });
				}
			}
		}

		return this.json({ delivered, attempted: sockets.length });
	}

	webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
		const ctx = this.getConnectionContext(ws);
		if (!ctx) {
			ws.close(1008, 'missing session');
			return;
		}
		ws.accept();

		if (typeof message === 'string') {
			const trimmed = message.trim().toLowerCase();
			if (trimmed === 'ping') ws.send('pong');
		}
	}

	webSocketClose(ws: WebSocket, code: number): void {
		ws.accept();
		const ctx = this.getConnectionContext(ws);
		if (!ctx) return;
		if (code !== 1000) {
			console.warn('websocket closed abnormally', { userId: ctx.userId, code });
		}
	}

	private getConnectionContext(ws: WebSocket): { userId: string } | null {
		const attachment = ws.deserializeAttachment();
		if (attachment && typeof (attachment as { userId?: unknown }).userId === 'string') {
			return attachment as { userId: string };
		}
		return null;
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
			if (!auth) return new Response('Unauthorized', { status: 401 });

			const userId = auth.userId.trim();
			if (!userId) return new Response('Unauthorized', { status: 401 });

			const stub = stubForUser(env, userId);

			// Forward the upgrade with an added X-User-ID header (no need to re-verify in DO)
			const forwarded = withAddedHeader(request, 'x-user-id', userId, '/connect');
			return stub.fetch(forwarded);
		}

		// Process publish entirely here; send canonical envelope to the user's DO
		if (method === 'POST' && url.pathname === '/publish') {
			const auth = await authenticate(request.headers.get('Authorization'), env.JWT_SECRET, url.searchParams.get('token'));
			if (!auth) return json({ error: 'Unauthorized' }, 401);

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
			// if (auth.userId !== userId) return json({ error: 'Forbidden' }, 403);

			const type = typeof body.type === 'string' && body.type.trim().length > 0 ? body.type.trim() : 'message';

			const envelope: RealtimeEnvelope = {
				type,
				userId,
				timestamp: new Date().toISOString(),
				...(body.payload !== undefined ? { payload: body.payload } : {}),
			};

			const stub = stubForUser(env, userId);

			const deliverReq = new Request(new URL('/deliver', request.url), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
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
