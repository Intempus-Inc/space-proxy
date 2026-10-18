let requests = [];

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/requests") return Response.json(requests);
    requests.push({ origin: url.origin, path: url.pathname });
    if (url.origin !== "https://example-demo.hf.space" ||
        request.headers.get("Authorization") !== "Bearer test-secret-not-a-credential") {
      return new Response("Unexpected upstream request", { status: 403 });
    }
    if (url.pathname === "/redirect") {
      return new Response(null, { status: 302, headers: { Location: url.searchParams.get("to") } });
    }
    if (url.pathname === "/range") {
      if (request.headers.get("Range") !== "bytes=1-3") return new Response(null, { status: 416 });
      return new Response(new Uint8Array([20, 30, 40]), {
        status: 206,
        headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 1-3/5", "Accept-Ranges": "bytes" },
      });
    }
    if (url.pathname === "/cookies") {
      const headers = new Headers();
      headers.append("Set-Cookie", "one=first; Secure; HttpOnly; SameSite=Lax; Path=/");
      headers.append("Set-Cookie", "two=second; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/");
      return new Response("ok", { headers });
    }
    if (url.pathname === "/socket" || url.pathname === "/cors") {
      if (request.headers.get("Origin") !== "https://demo.example.com") {
        return new Response("Origin denied", { status: 403 });
      }
      if (url.pathname === "/cors") {
        return new Response(null, {
          status: 204,
          headers: { "Access-Control-Allow-Origin": "https://demo.example.com", "Vary": "Origin" },
        });
      }
      const [client, server] = Object.values(new WebSocketPair());
      server.binaryType = "arraybuffer";
      server.accept();
      server.addEventListener("message", event => server.send(event.data));
      server.addEventListener("close", event => server.close(event.code, event.reason));
      return new Response(null, {
        status: 101, webSocket: client,
        headers: { Authorization: "Bearer test-secret-not-a-credential" },
      });
    }
    return Response.json({
      url: request.url, method: request.method, body: await request.text(),
      cookie: request.headers.get("Cookie"), origin: request.headers.get("Origin"),
      forwardedHost: request.headers.get("X-Forwarded-Host"),
      forwardedProto: request.headers.get("X-Forwarded-Proto"),
    });
  },
};
