function configuration(env) {
  try {
    const publicUrl = new URL(env.PUBLIC_ORIGIN);
    const upstreamUrl = new URL(env.SPACE_ORIGIN);
    for (const url of [publicUrl, upstreamUrl]) {
      if (url.protocol !== "https:" || url.username || url.password || url.port ||
          url.pathname !== "/" || url.search || url.hash) return null;
    }
    if (!/^[a-z0-9][a-z0-9-]*\.hf\.space$/.test(upstreamUrl.hostname)) return null;
    if (publicUrl.origin === upstreamUrl.origin || typeof env.HF_TOKEN !== "string" ||
        !env.HF_TOKEN.trim() || /[\r\n]/.test(env.HF_TOKEN)) return null;
    return { publicUrl, upstreamUrl };
  } catch {
    return null;
  }
}

function responseHeaders(original) {
  const headers = new Headers(original);
  headers.delete("authorization");
  headers.set("Cache-Control", "private, no-store");
  headers.set("CDN-Cache-Control", "no-store");
  headers.set("Cloudflare-CDN-Cache-Control", "no-store");
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "same-origin");
  headers.set("Permissions-Policy", "camera=(self), microphone=()");
  return headers;
}

function unavailable(status = 502) {
  return new Response("Service temporarily unavailable.\n", {
    status,
    headers: responseHeaders({ "Content-Type": "text/plain; charset=utf-8" }),
  });
}

export async function proxy(request, env, fetchUpstream = fetch) {
  const config = configuration(env);
  if (!config) return unavailable(503);
  const { publicUrl, upstreamUrl } = config;
  const incoming = new URL(request.url);
  if (incoming.host !== publicUrl.host) {
    return new Response("Not found.\n", { status: 404, headers: responseHeaders() });
  }
  if (incoming.protocol !== "https:") {
    return new Response(null, {
      status: 308,
      headers: responseHeaders({ Location: publicUrl.origin + incoming.pathname + incoming.search }),
    });
  }

  const target = new URL(upstreamUrl);
  target.pathname = incoming.pathname;
  target.search = incoming.search;
  const headers = new Headers(request.headers);
  for (const name of ["authorization", "proxy-authorization", "host", "forwarded"]) {
    headers.delete(name);
  }
  headers.set("Authorization", `Bearer ${env.HF_TOKEN}`);
  headers.set("X-Forwarded-Host", publicUrl.hostname);
  headers.set("X-Forwarded-Proto", "https");
  headers.set("Cache-Control", "no-store");
  const outbound = new Request(target, new Request(request, { headers, redirect: "manual" }));
  let upstream;
  try {
    upstream = await fetchUpstream(outbound, { cf: { cacheEverything: false, cacheTtl: 0 } });
  } catch {
    return unavailable();
  }

  if (upstream.status === 101) {
    return new Response(null, {
      status: 101,
      webSocket: upstream.webSocket,
      headers: responseHeaders(upstream.headers),
    });
  }
  const outgoing = responseHeaders(upstream.headers);
  const location = outgoing.get("Location");
  if (upstream.status >= 300 && upstream.status < 400 && location) {
    let redirect;
    try {
      redirect = new URL(location, target);
    } catch {
      return unavailable();
    }
    if (redirect.origin !== upstreamUrl.origin || redirect.username || redirect.password) {
      return unavailable();
    }
    outgoing.set("Location", publicUrl.origin + redirect.pathname + redirect.search + redirect.hash);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outgoing,
  });
}

export default {
  fetch(request, env) {
    return proxy(request, env);
  },
};
