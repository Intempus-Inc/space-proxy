import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

const PUBLIC_ORIGIN = "https://demo.example.com";
const SPACE_ORIGIN = "https://example-demo.hf.space";

test("Cloudflare runtime forwards only to the configured Space", { timeout: 30000 }, async t => {
  const runtime = new Miniflare({
    workers: [
      {
        name: "proxy", modules: true, compatibilityDate: "2026-07-30",
        scriptPath: fileURLToPath(new URL("../worker.mjs", import.meta.url)),
        bindings: { PUBLIC_ORIGIN, SPACE_ORIGIN, HF_TOKEN: "test-secret-not-a-credential" },
        outboundService: "origin",
      },
      {
        name: "origin", modules: true, compatibilityDate: "2026-07-30",
        scriptPath: fileURLToPath(new URL("origin.fixture.mjs", import.meta.url)),
      },
    ],
  });
  t.after(() => runtime.dispose());
  const fetch = (path, init) => runtime.dispatchFetch(PUBLIC_ORIGIN + path, init);
  const origin = await runtime.getWorker("origin");

  await t.test("POST body, query, cookie and origin survive; caller token does not", async () => {
    const response = await fetch("/echo?x=one%20two", {
      method: "POST", body: "payload", headers: {
        Authorization: "Bearer caller", Cookie: "session=example", Origin: PUBLIC_ORIGIN,
        "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "http",
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      url: SPACE_ORIGIN + "/echo?x=one%20two", method: "POST", body: "payload",
      cookie: "session=example", origin: PUBLIC_ORIGIN,
      forwardedHost: "demo.example.com", forwardedProto: "https",
    });
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  });

  await t.test("range response retains bytes and media headers", async () => {
    const response = await fetch("/range", { headers: { Range: "bytes=1-3" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), "bytes 1-3/5");
    assert.equal(response.headers.get("Accept-Ranges"), "bytes");
    assert.equal(response.headers.get("Content-Type"), "video/mp4");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [20, 30, 40]);
  });

  await t.test("multiple cookies remain separate", async () => {
    const response = await fetch("/cookies");
    assert.deepEqual(response.headers.getSetCookie(), [
      "one=first; Secure; HttpOnly; SameSite=Lax; Path=/",
      "two=second; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
    ]);
  });

  await t.test("same-Space redirects are rewritten without being followed", async () => {
    const response = await fetch("/redirect?to=%2Flogin", { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("Location"), PUBLIC_ORIGIN + "/login");
  });

  await t.test("external, credentialed and HTTP redirects make no second request", async () => {
    for (const to of ["https://attacker.example/", "//attacker.example/", "http://example-demo.hf.space/", "https://user@example-demo.hf.space/"]) {
      const before = await (await origin.fetch(SPACE_ORIGIN + "/requests")).json();
      const response = await fetch("/redirect?to=" + encodeURIComponent(to), { redirect: "manual" });
      const after = await (await origin.fetch(SPACE_ORIGIN + "/requests")).json();
      assert.equal(response.status, 502);
      assert.equal(response.headers.get("Location"), null);
      assert.equal(after.length, before.length + 1);
      assert.equal(after.at(-1).origin, SPACE_ORIGIN);
    }
  });

  await t.test("CORS permissions remain the app's decision", async () => {
    const allowed = await fetch("/cors", { method: "OPTIONS", headers: { Origin: PUBLIC_ORIGIN } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), PUBLIC_ORIGIN);
    assert.equal(allowed.headers.get("Vary"), "Origin");
    const denied = await fetch("/cors", { method: "OPTIONS", headers: { Origin: "https://attacker.example" } });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  });

  await t.test("WebSocket origin rejection survives the proxy", async () => {
    const response = await fetch("/socket", { headers: { Upgrade: "websocket", Origin: "https://attacker.example" } });
    assert.equal(response.status, 403);
    assert.equal(response.webSocket, null);
  });

  await t.test("WebSocket text and binary frames make a round trip", async () => {
    const response = await fetch("/socket", { headers: { Upgrade: "websocket", Origin: PUBLIC_ORIGIN } });
    assert.equal(response.status, 101);
    assert.equal(response.headers.get("Authorization"), null);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    const socket = response.webSocket;
    assert.ok(socket);
    socket.accept();
    const roundTrip = value => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket reply timed out")), 5000);
      socket.addEventListener("message", event => { clearTimeout(timer); resolve(event.data); }, { once: true });
      socket.send(value);
    });
    try {
      assert.equal(await roundTrip("hello"), "hello");
      const binary = await roundTrip(new Uint8Array([0, 255, 128, 1]));
      assert.deepEqual([...new Uint8Array(binary)], [0, 255, 128, 1]);
    } finally {
      socket.close(1000, "test complete");
    }
  });

  const requests = await (await origin.fetch(SPACE_ORIGIN + "/requests")).json();
  assert.ok(requests.length > 0);
  assert.ok(requests.every(request => request.origin === SPACE_ORIGIN));
});
