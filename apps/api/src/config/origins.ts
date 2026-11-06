/**
 * 两个公开 origin 的唯一解析入口。
 *
 * - `SMEDC_API_ORIGIN`：OAuth issuer、MCP host 守卫、令牌端点。机器客户端只认它。
 * - `SMEDC_WEB_ORIGIN`：浏览器页面、网页接口的 Origin 校验、发给用户的网页链接。
 *
 * 两者分开是因为网页搬到 app 域之后，写操作的 `Origin` 头只会是网页 origin，
 * 而 issuer 必须留在 api 域供已安装的 Launcher 使用。
 */

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface ApiOrigins {
  readonly apiOrigin: string;
  readonly webOrigin: string;
}

interface CanonicalOriginOptions {
  readonly allowLoopbackHttp: boolean;
}

function canonicalOrigin(value: string, label: string, options: CanonicalOriginOptions): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a canonical origin`);
  }

  if (url.username || url.password) {
    throw new Error(`${label} must not include credentials`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${label} must not include a path, query, or fragment`);
  }

  if (url.protocol === "https:") {
    if (url.port && url.port !== "443") {
      throw new Error(`${label} must use the default HTTPS port`);
    }
    return url.origin;
  }

  if (
    url.protocol === "http:" &&
    options.allowLoopbackHttp &&
    LOOPBACK_HOSTNAMES.has(url.hostname)
  ) {
    return url.origin;
  }

  throw new Error(
    options.allowLoopbackHttp
      ? `${label} must use HTTPS, or loopback HTTP for local development`
      : `${label} must use HTTPS`
  );
}

/** 机器客户端可见的 origin：不允许任何明文 HTTP。 */
export function canonicalApiOrigin(value: string, label = "SMEDC_API_ORIGIN"): string {
  return canonicalOrigin(value, label, { allowLoopbackHttp: false });
}

/** 浏览器 origin：生产必须是 HTTPS；本地开发允许 loopback HTTP，否则 `__Host-` Cookie 无法在本机验证。 */
export function canonicalWebOrigin(value: string, label = "SMEDC_WEB_ORIGIN"): string {
  return canonicalOrigin(value, label, { allowLoopbackHttp: true });
}

export function resolveApiOrigins(environment: NodeJS.ProcessEnv): ApiOrigins {
  const api = environment["SMEDC_API_ORIGIN"]?.trim();
  const web = environment["SMEDC_WEB_ORIGIN"]?.trim();

  if (!api) {
    throw new Error("SMEDC_API_ORIGIN is required for official authentication.");
  }
  if (!web) {
    throw new Error("SMEDC_WEB_ORIGIN is required for the web application.");
  }

  return {
    apiOrigin: canonicalApiOrigin(api),
    webOrigin: canonicalWebOrigin(web)
  };
}
