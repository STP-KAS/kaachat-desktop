import { defineConfig } from "vite";
import http from "node:http";
import https from "node:https";

// Same-origin Nextcloud proxy. The desktop app runs in a browser, and stock Nextcloud sends no
// CORS headers on WebDAV/OCS — so ui/nextcloud.js routes every API call through
//   /nc-proxy/<encodeURIComponent(origin)>/<path>
// and this middleware forwards it server-side, where CORS doesn't exist. Public /s/TOKEN share
// links are NOT proxied — recipients open those on the real server.
//
// Note: with `--host 0.0.0.0` this proxy is reachable from the LAN like the rest of the dev
// server — it forwards only to the origin encoded in each request's own path (no ambient
// credentials; the browser supplies the Authorization header per request).
function nextcloudProxy() {
  return {
    name: "kachat-nextcloud-proxy",
    configureServer(server) {
      server.middlewares.use("/nc-proxy", (req, res) => {
        // connect strips the "/nc-proxy" mount prefix, so req.url is "/<origin>/<path>?<query>".
        const match = /^\/([^/]+)(\/.*)?$/.exec(req.url || "");
        let origin = null;
        try {
          origin = match ? new URL(decodeURIComponent(match[1])) : null;
        } catch { /* handled below */ }
        if (!origin || (origin.protocol !== "http:" && origin.protocol !== "https:")) {
          res.statusCode = 400;
          res.end("Bad proxy target");
          return;
        }
        const headers = { ...req.headers, host: origin.host };
        // The browser's origin/referer would confuse some reverse-proxy setups — drop them.
        delete headers.origin;
        delete headers.referer;
        const client = origin.protocol === "http:" ? http : https;
        const upstream = client.request(
          {
            protocol: origin.protocol,
            hostname: origin.hostname,
            port: origin.port || (origin.protocol === "http:" ? 80 : 443),
            method: req.method,
            path: match[2] || "/",
            headers,
          },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );
        upstream.on("error", (error) => {
          if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
          res.end(`Proxy error: ${error.message}`);
        });
        req.pipe(upstream);
      });
    },
  };
}

export default defineConfig({
  plugins: [nextcloudProxy()],
});
