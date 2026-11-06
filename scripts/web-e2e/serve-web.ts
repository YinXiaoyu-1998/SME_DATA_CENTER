/**
 * 与生产 Nginx 同构的本地静态站点：
 * - /api/web/v1/、/oauth/device/、/auth/password/ 原样转发到 API
 * - 其余路径回落到 index.html（SPA 路由）
 *
 * 用同一台主机同一端口服务页面与接口，浏览器视角始终同源，
 * 因此 __Host- Cookie、CSRF 与 Origin 校验的代码路径与线上一致。
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";

const PROXIED_PREFIXES = ["/api/web/v1/", "/oauth/device/", "/auth/password/"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
};

export interface WebServerOptions {
  webRoot: string;
  apiPort: number;
  port: number;
}

export function startWebServer(options: WebServerOptions) {
  const server = createServer((incoming, response) => {
    const url = incoming.url ?? "/";

    if (PROXIED_PREFIXES.some((prefix) => url.startsWith(prefix))) {
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: options.apiPort,
          method: incoming.method,
          path: url,
          headers: { ...incoming.headers, host: `localhost:${options.port}` }
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        }
      );
      upstream.on("error", () => {
        response.writeHead(502).end("upstream unavailable");
      });
      incoming.pipe(upstream);
      return;
    }

    const pathname = decodeURIComponent(url.split("?")[0] ?? "/");
    const candidate = path.join(options.webRoot, pathname);
    const inside = candidate.startsWith(options.webRoot);
    const file =
      inside && existsSync(candidate) && statSync(candidate).isFile()
        ? candidate
        : path.join(options.webRoot, "index.html");
    const type = MIME[path.extname(file)] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    createReadStream(file).pipe(response);
  });

  return new Promise<{ close: () => Promise<void> }>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      resolve({
        close: () => new Promise<void>((done) => server.close(() => done()))
      });
    });
  });
}
