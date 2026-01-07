# HopeFlow Realtime

HopeFlow Realtime is a Cloudflare Worker + Durable Object pair that provides per-user WebSocket fan-out with a simple authenticated publish API. Browser or server clients connect over WebSockets, while trusted backends can publish JSON envelopes that are delivered to every active socket for that user.

## Architecture

- **Outer Worker (`src/index.ts`)** authenticates requests with a shared `JWT_SECRET`. WebSocket upgrades are routed to the user’s Durable Object, while `POST /publish` accepts JSON payloads and hands them off for delivery.
- **Durable Object (`HopeFlowRealtime`)** maintains all live WebSocket sessions for a single user. It supports:
  - `WS /connect` (invoked by the outer worker with an added `X-User-ID` header).
  - `POST /deliver` for canonical envelopes dispatched from `/publish`.
  - Automatic hibernation up to 1 hour to minimize cold starts.
- **JSON responses** include permissive CORS headers (`*` origin) so dashboards or browser tooling can hit `/publish` when authorized.

## Requirements

- Node 18+ (Cloudflare Workers runtime target)
- [`pnpm`](https://pnpm.io/) for dependency management
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) ≥ v4.45 (already listed in devDependencies)

## Getting Started

```bash
pnpm install           # install deps
pnpm dev               # wrangler dev (defaults to local mode)
pnpm deploy            # wrangler deploy to your account
pnpm cf-typegen        # optional: regenerate type bindings
```

Wrangler reads secrets from `.dev.vars` during `pnpm dev`. At minimum define:

```
JWT_SECRET=super-long-random-string
```

For production, run `wrangler secret put JWT_SECRET` and ensure the Durable Object binding name `HOPEFLOW_REALTIME` matches the one declared in `wrangler.jsonc`.

## API

### WebSocket

- **Endpoint:** `wss://<worker-domain>/`
- **Headers:** `Authorization: Bearer <JWT>` (payload must include a `userId` string). Browsers may also pass `?token=<JWT>` query param.
- **Subscriptions:** After connect, clients must send `{"type":"subscribe","filters":[{ "type": "chat_message", "questId": "q1", "nodeId": "n1" }]}`. Filters match exactly on provided keys against the envelope: `type` compares to the envelope `type`, other keys compare to fields inside the JSON `payload`. Add filters with `subscribe`, remove with `{"type":"unsubscribe","filters":[...]}`.
- **Acks:** For each delivered envelope, clients should respond with `{"type":"ack","envelopeId":"<id>","result":<any>}`. Results are returned to the `/publish` caller.
- **Behavior:** Server replies `pong` to `ping` (case-insensitive). Only sockets with at least one matching filter receive a message.

### Publish

- **Endpoint:** `POST https://<worker-domain>/publish`
- **Headers:** `Authorization: Bearer <JWT>` (or `?token=<JWT>` query param), `Content-Type: application/json`
- **Body:**

```json
{
  "userId": "user_123",
  "type": "message",        // optional; defaults to "message"
  "payload": { "any": "json" }
}
```

- **Rules:** Multi-tenant publish is allowed; `userId` in the body is the delivery target. `envelopeId` is generated for you; you don’t need to supply one. Requests without JSON bodies receive error responses.
- **Response:** `{"clientCount": <delivered-to>, "results": [<ack results>...]}`. The worker waits up to 5s for client acknowledgments and returns whatever arrived; `clientCount` reflects sockets that matched at least one subscription filter.
- **CORS:** `OPTIONS /publish` is preflight-enabled with `*` origin for browser usage.
- **Ack behavior:** Each delivered envelope should be acked with `{"type":"ack","envelopeId":"<id>","result":<any>}`. If `result` is omitted, the server records `null` for that client in the returned `results` array.
- **Subscription rules:** Filters are exact-match and must be objects with string values (including `type`). Up to 50 filters are processed per subscribe/unsubscribe message.

## JWT Expectations

Tokens are verified with HS256 using `JWT_SECRET`. The payload must include a non-empty `userId` string. Other claims are passed through untouched and can be extended later.

## Deployment Notes

- Update `wrangler.jsonc` with your Cloudflare account details (routes, D1/queues, etc.) as needed.
- The included migration (`tag: v1`) registers the Durable Object class; run `wrangler deploy --migrations` the first time or whenever tags change.
- Use Smart Placement or other placement settings if latency-sensitive (commented template already in `wrangler.jsonc`).

## Troubleshooting

- **Unauthorized (401):** Check that the Authorization header is present and the token contains `userId`.
- **Unsupported Media Type (415):** Ensure `Content-Type: application/json` on `/publish`.
- **Delivery count < active clients:** The Durable Object logs errors when sockets fail; inspect Cloudflare tail logs (`wrangler tail`) for per-user traces.
