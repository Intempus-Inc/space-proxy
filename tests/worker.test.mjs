import test from "node:test";
import assert from "node:assert/strict";
import worker, { proxy } from "../worker.mjs";

const ORIGIN = "https://demo.example.com";
const UPSTREAM = "https://example-demo.hf.space";
const env = { PUBLIC_ORIGIN: ORIGIN, SPACE_ORIGIN: UPSTREAM, HF_TOKEN: "test-secret-not-a-credential" };
const unexpectedFetch = () => assert.fail("Unexpected upstream fetch");

test("Worker entry point does not treat Cloudflare execution context as fetch", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async request => {
    calls++;
    assert.equal(new URL(request.url).origin, UPSTREAM);
    return new Response("ok");
  });
  const response = await worker.fetch(new Request(ORIGIN), env, { waitUntil() {} });
  assert.equal(await response.text(), "ok");
  assert.equal(calls, 1);
});

test("missing token fails closed without contacting the Space", async () => {
  const response = await proxy(new Request(ORIGIN), { ...env, HF_TOKEN: "" }, unexpectedFetch);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("invalid deployment origins and credentials fail before any fetch", async () => {
  for (const overrides of [
    { PUBLIC_ORIGIN: undefined }, { SPACE_ORIGIN: undefined },
    { PUBLIC_ORIGIN: "http://demo.example.com" },
    { PUBLIC_ORIGIN: "https://demo.example.com:444" },
    { PUBLIC_ORIGIN: "https://user@demo.example.com" },
    { PUBLIC_ORIGIN: "https://demo.example.com/path" },
    { PUBLIC_ORIGIN: "https://demo.example.com/?query=one" },
    { PUBLIC_ORIGIN: "https://demo.example.com/#fragment" },
    { SPACE_ORIGIN: "https://attacker.example" },
    { SPACE_ORIGIN: "https://example-demo.hf.space.attacker.example" },
    { SPACE_ORIGIN: "http://example-demo.hf.space" },
    { SPACE_ORIGIN: "https://example-demo.hf.space:444" },
    { SPACE_ORIGIN: "https://user@example-demo.hf.space" },
    { SPACE_ORIGIN: "https://example-demo.hf.space/path" },
    { SPACE_ORIGIN: "https://example-demo.hf.space/?query=one" },
    { SPACE_ORIGIN: "https://example-demo.hf.space/#fragment" },
    { PUBLIC_ORIGIN: UPSTREAM },
    { HF_TOKEN: undefined }, { HF_TOKEN: "   " }, { HF_TOKEN: 42 }, { HF_TOKEN: "example\r\nheader" },
  ]) {
    const response = await proxy(new Request(ORIGIN), { ...env, ...overrides }, unexpectedFetch);
    assert.equal(response.status, 503, JSON.stringify(overrides));
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  }
});

test("other hosts are rejected and HTTP redirects only to the public origin", async () => {
  const rejected = await proxy(new Request("https://attacker.example/"), env, unexpectedFetch);
  assert.equal(rejected.status, 404);
  const wrongPort = await proxy(new Request(ORIGIN + ":444/"), env, unexpectedFetch);
  assert.equal(wrongPort.status, 404);
  const redirected = await proxy(new Request("http://demo.example.com/explorer/?x=1"), env, unexpectedFetch);
  assert.equal(redirected.status, 308);
  assert.equal(redirected.headers.get("Location"), ORIGIN + "/explorer/?x=1");
});

test("upstream authorization response headers are removed", async () => {
  const response = await proxy(new Request(ORIGIN), env, async () => new Response("ok", {
    headers: { Authorization: `Bearer ${env.HF_TOKEN}` },
  }));
  assert.equal(response.headers.get("Authorization"), null);
});

test("paths and queries cannot change the fixed upstream host", async () => {
  for (const path of ["/explorer/?clip=one", "//attacker.example/a", "/https://attacker.example/?url=https://elsewhere.example/"]) {
    let calls = 0;
    const response = await proxy(new Request(ORIGIN + path), env, async (request, options) => {
      calls++;
      const url = new URL(request.url);
      assert.equal(url.origin, UPSTREAM);
      assert.equal(url.pathname, new URL(ORIGIN + path).pathname);
      assert.equal(url.search, new URL(ORIGIN + path).search);
      assert.equal(request.redirect, "manual");
      assert.equal(options.cf.cacheTtl, 0);
      return new Response("ok");
    });
    assert.equal(calls, 1);
    assert.equal(await response.text(), "ok");
  }
});

test("caller auth and proxy headers cannot override the private Space token", async () => {
  const incoming = new Request(ORIGIN + "/login", {
    method: "POST",
    headers: {
      Authorization: "Bearer attacker",
      "Proxy-Authorization": "Bearer attacker",
      Host: "attacker.example",
      Forwarded: "host=attacker.example;proto=http",
      "X-Forwarded-Host": "attacker.example",
      "X-Forwarded-Proto": "http",
      Cookie: "session=opaque",
      Origin: ORIGIN,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=example",
  });
  await proxy(incoming, env, async request => {
    assert.equal(request.method, "POST");
    assert.equal(await request.text(), "password=example");
    assert.equal(request.headers.get("Authorization"), `Bearer ${env.HF_TOKEN}`);
    assert.equal(request.headers.get("Proxy-Authorization"), null);
    assert.equal(request.headers.get("Host"), null);
    assert.equal(request.headers.get("Forwarded"), null);
    assert.equal(request.headers.get("X-Forwarded-Host"), "demo.example.com");
    assert.equal(request.headers.get("X-Forwarded-Proto"), "https");
    assert.equal(request.headers.get("Cookie"), "session=opaque");
    assert.equal(request.headers.get("Origin"), ORIGIN);
    return new Response("ok");
  });
  assert.equal(incoming.headers.get("Authorization"), "Bearer attacker");
});

test("video range status, bytes and headers survive with no caching", async () => {
  const response = await proxy(new Request(ORIGIN + "/local-media/clip", {
    headers: { Range: "bytes=0-3", "If-Range": '"clip-version"' },
  }), env, async request => {
    assert.equal(request.headers.get("Range"), "bytes=0-3");
    assert.equal(request.headers.get("If-Range"), '"clip-version"');
    return new Response(new Uint8Array([0, 1, 2, 3]), {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Range": "bytes 0-3/100",
        "Accept-Ranges": "bytes",
        "Content-Length": "4",
        "Cache-Control": "public, max-age=3600",
      },
    });
  });
  assert.equal(response.status, 206);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([0, 1, 2, 3]));
  assert.equal(response.headers.get("Content-Range"), "bytes 0-3/100");
  assert.equal(response.headers.get("Content-Length"), "4");
  assert.equal(response.headers.get("Accept-Ranges"), "bytes");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Cloudflare-CDN-Cache-Control"), "no-store");
  assert.equal(response.headers.get("Strict-Transport-Security"), "max-age=31536000");
});

test("session cookies remain separate, including an Expires comma", async () => {
  const cookies = [
    "session=opaque; Secure; HttpOnly; SameSite=Lax; Path=/",
    "other=value; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/",
  ];
  const response = await proxy(new Request(ORIGIN), env, async () => {
    const headers = new Headers();
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response("ok", { headers });
  });
  assert.deepEqual(response.headers.getSetCookie(), cookies);
});

test("fixed-host and relative redirects are rewritten without following", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    for (const location of [UPSTREAM + "/login?next=%2Fexplorer%2F#form", "/login?next=%2Fexplorer%2F#form"]) {
      let calls = 0;
      const response = await proxy(new Request(ORIGIN + "/explorer/"), env, async request => {
        calls++;
        assert.equal(request.redirect, "manual");
        return new Response(null, { status, headers: { Location: location } });
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("Location"), ORIGIN + "/login?next=%2Fexplorer%2F#form");
      assert.equal(calls, 1);
    }
  }
});

test("external, downgrade and userinfo redirects fail without leaking or following", async () => {
  for (const location of [
    "https://huggingface.co/login",
    "//attacker.example/",
    "http://example-demo.hf.space/",
    "https://example-demo.hf.space.attacker.example/",
    "https://attacker.example@example-demo.hf.space/",
    "javascript:alert(1)",
    "http://[",
  ]) {
    let calls = 0;
    const response = await proxy(new Request(ORIGIN), env, async () => {
      calls++;
      return new Response(null, { status: 302, headers: { Location: location } });
    });
    assert.equal(calls, 1);
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Location"), null);
    assert.equal((await response.text()).includes(env.HF_TOKEN), false);
  }
});

test("errors and ordinary upstream statuses survive without exposing internals", async () => {
  for (const status of [401, 403, 404, 416, 503]) {
    const response = await proxy(new Request(ORIGIN), env, async () => new Response("upstream", { status }));
    assert.equal(response.status, status);
  }
  const failed = await proxy(new Request(ORIGIN), env, async () => { throw new Error(env.HF_TOKEN); });
  assert.equal(failed.status, 502);
  assert.equal((await failed.text()).includes(env.HF_TOKEN), false);
});
