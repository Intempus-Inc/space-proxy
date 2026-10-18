# Space proxy

A small Cloudflare Worker that serves an app from a private Hugging Face Space
at your own domain. It forwards HTTP bodies, video range requests and WebSockets,
keeps the Space token in Worker secrets, and disables response caching.

The app becomes publicly reachable. Treat every app route as public unless the
app enforces its own authentication. Use a dedicated serving app with explicit
routes; keep weights, participant records and other private files outside its
file-serving directories. Space repository privacy is separate from app access.

## Deploy

Use Node 22 or newer and a domain managed by Cloudflare.

```sh
npm ci
npm test
npx wrangler login
```

Edit `wrangler.jsonc`: set the custom domain route and `PUBLIC_ORIGIN` to your
domain, and `SPACE_ORIGIN` to your Space's `https://...hf.space` origin. Origins
must use HTTPS, with no credentials, port, path, query or fragment.

Store a fine-grained Hugging Face token with read access to that Space:

```sh
npx wrangler secret put HF_TOKEN
npm run deploy
```

Configure the app to accept the public origin for browser and WebSocket traffic.
The Worker forwards `Origin` unchanged and adds no CORS permissions. Its
permissions policy allows same-origin camera access and blocks microphone access. It replaces
incoming authorization with the Space token, so any separate app login should
use a cookie rather than the `Authorization` header.

Same-Space redirects are rewritten to your public domain. External redirects
are rejected without following them. Missing or invalid configuration returns
503. Upstream failure returns 502. Only the configured public host is accepted;
HTTP requests redirect to HTTPS. Workers.dev and preview URLs are disabled.

## Checks

`npm test` checks request/response handling and runs the Worker in Cloudflare's
local runtime against a synthetic upstream, including binary WebSocket frames,
video ranges, cookies, CORS and redirect boundaries. Tests use no credentials or
external services. Run a smoke test against your own deployed app as well.

Extracted from Intempus's Pathos serving tools. No models or study data are
included. Code: [MIT](LICENSE).
