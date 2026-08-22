#!/usr/bin/env node
// Standalone /nc-proxy server for the STATIC (nginx-served) test deployment.
//
// The app routes several cross-origin, CORS-less calls through a same-origin
//   /nc-proxy/<encodeURIComponent(origin)>/<path>
// passthrough that the Vite dev server provides via vite.config.mjs's nextcloudProxy().
// A static `vite build` has no dev server, so this tiny server reproduces that endpoint for:
//   - KNS name resolution        (engine/kns.js — always proxied; some endpoints omit CORS)
//   - link-preview og: scraping  (ui/app.js — x-preview: crawler UA)
//   - Nextcloud WebDAV/OCS        (ui/nextcloud.js — opt-in)
// (Indexer + api.kaspa.org are NOT proxied in a production build — they go direct with CORS.)
//
// SSRF hardening: unlike the dev-server version (which allows RFC1918 for a LAN Nextcloud), this
// is PUBLIC-facing and proxies arbitrary user-pasted URLs (link previews), so it RESOLVES the
// target host and blocks any private / loopback / link-local / metadata / CGNAT address — on the
// initial target and on every redirect hop. Public URLs (KNS, link targets, hosted Nextcloud)
// keep working; a request that would reach the server's own network is refused.
//
// Keep the forwarding behavior in sync with nextcloudProxy() in vite.config.mjs.
import http from "node:http";
import https from "node:https";
import dns from "node:dns/promises";

const PORT = Number(process.env.NC_PROXY_PORT || 8790);
const HOST = process.env.NC_PROXY_HOST || "0.0.0.0";
const MAX_REDIRECT_HOPS = 5;

function ipIsBlocked(ip) {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;         // this-host, 10/8, loopback
    if (a === 169 && b === 254) return true;                    // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16/12
    if (a === 192 && b === 168) return true;                    // 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;
  if (low.startsWith("::ffff:")) return ipIsBlocked(low.slice("::ffff:".length)); // v4-mapped
  if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true; // link-local + ULA
  return false;
}

async function hostBlocked(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h === "metadata.google.internal") return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return ipIsBlocked(h);
  try {
    const addrs = await dns.lookup(h, { all: true });
    return addrs.length === 0 || addrs.some((a) => ipIsBlocked(a.address));
  } catch {
    return true; // unresolvable -> refuse
  }
}

async function handle(req, res) {
  // nginx passes the full path; strip the /nc-proxy mount to mirror connect's behavior.
  let rest = (req.url || "").replace(/^\/nc-proxy(?=\/|$)/, "");
  const match = /^\/([^/]+)(\/.*)?$/.exec(rest);
  let origin = null;
  try { origin = match ? new URL(decodeURIComponent(match[1])) : null; } catch { /* below */ }
  if (!origin || (origin.protocol !== "http:" && origin.protocol !== "https:")) {
    res.statusCode = 400; res.end("Bad proxy target"); return;
  }
  if (await hostBlocked(origin.hostname)) {
    res.statusCode = 403; res.end("Proxy target not allowed"); return;
  }

  const headers = { ...req.headers, host: origin.host };
  delete headers.origin;
  delete headers.referer;
  if (headers["x-preview"] === "1") {
    const h = origin.hostname.replace(/^www\./, "").toLowerCase();
    const browserUaHosts = new Set(["x.com", "twitter.com", "mobile.twitter.com"]);
    headers["user-agent"] = browserUaHosts.has(h)
      ? "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
      : "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
    delete headers.accept;
    headers.accept = "text/html,application/xhtml+xml";
  }
  delete headers["x-preview"];
  const soft404 = headers["x-proxy-soft-404"] === "1";
  delete headers["x-proxy-soft-404"];

  function forward(target, hop) {
    const client = target.protocol === "http:" ? http : https;
    const upstream = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        method: req.method,
        path: `${target.pathname}${target.search}` || "/",
        headers: { ...headers, host: target.host },
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode || 502;
        const location = upstreamRes.headers.location;
        if (location && status >= 300 && status < 400 && hop < MAX_REDIRECT_HOPS
            && (req.method === "GET" || req.method === "HEAD")) {
          upstreamRes.resume();
          let next = null;
          try { next = new URL(location, target); } catch { next = null; }
          if (next && (next.protocol === "http:" || next.protocol === "https:")) {
            // A redirect must obey the same SSRF guard as the original target.
            hostBlocked(next.hostname).then((blocked) => {
              if (blocked) { if (!res.headersSent) res.writeHead(403); res.end("Redirect target not allowed"); }
              else forward(next, hop + 1);
            });
            return;
          }
        }
        const mask404 = soft404 && upstreamRes.statusCode === 404;
        const responseHeaders = { ...upstreamRes.headers };
        if (mask404) responseHeaders["x-upstream-status"] = "404";
        res.writeHead(mask404 ? 200 : status, responseHeaders);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Proxy error: ${error.message}`);
    });
    if (hop === 0) req.pipe(upstream); else upstream.end();
  }
  forward(new URL(match[2] || "/", `${origin.protocol}//${origin.host}`), 0);
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end(`nc-proxy error: ${e?.message || e}`);
  });
}).listen(PORT, HOST, () => {
  console.log(`nc-proxy listening on ${HOST}:${PORT}`);
});
