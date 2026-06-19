// Same-origin HTTP proxy that lets the Control UI read/control a local
// ACCELERANT API (default http://127.0.0.1:7317) which sends no CORS headers,
// so the browser cannot call it directly. This stage forwards GET/POST requests
// under the /accelerant/ prefix to the configured loopback ACCELERANT base URL
// and returns the upstream status + JSON body verbatim.
import type { IncomingMessage, ServerResponse } from "node:http";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import {
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayHttpRequestOrReply } from "./http-auth-utils.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Mount prefix for the ACCELERANT proxy. */
const ACCELERANT_PATH_PREFIX = "/accelerant/";
/** Bare mount path (no trailing subpath). */
const ACCELERANT_PATH_ROOT = "/accelerant";
/** Default loopback ACCELERANT API base URL when nothing else is configured. */
const DEFAULT_ACCELERANT_BASE_URL = "http://127.0.0.1:7317";
/** Header the UI may send to make the base URL operator-configurable. */
const ACCELERANT_BASE_URL_HEADER = "x-accelerant-base-url";
/** Body cap for forwarded JSON payloads. */
const MAX_ACCELERANT_BODY_BYTES = 1024 * 1024;
/** Upstream request timeout. */
const ACCELERANT_FETCH_TIMEOUT_MS = 30_000;
/** Methods the proxy is allowed to forward. */
const ALLOWED_METHODS = new Set(["GET", "POST"]);

/** Options threaded through from the gateway HTTP router. */
export type AccelerantHttpRequestOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  config: OpenClawConfig;
};

/** True for the bare mount path or any /accelerant/<subpath> request. */
export function isAccelerantHttpPath(pathname: string): boolean {
  return pathname === ACCELERANT_PATH_ROOT || pathname.startsWith(ACCELERANT_PATH_PREFIX);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * True when a parsed URL targets a loopback host (127.0.0.1 / localhost / ::1).
 * The header-supplied base URL is only trusted when it resolves to loopback so
 * the proxy can never be pointed at an arbitrary internal host.
 */
function isLoopbackBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "")
    .replace(/^\[(.*)\]$/, "$1");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Strip a single trailing slash so subpath joins stay predictable. */
function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function getHeaderValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return undefined;
}

/**
 * Resolve the ACCELERANT base URL in priority order:
 *  1. request header `x-accelerant-base-url` (only if it parses to a loopback origin)
 *  2. process.env.OPENCLAW_ACCELERANT_API_URL
 *  3. config.gateway.controlUi.accelerantApiBaseUrl
 *  4. default http://127.0.0.1:7317
 * The returned value has any trailing slash stripped.
 */
function resolveAccelerantBaseUrl(
  req: IncomingMessage,
  config: OpenClawConfig,
): string {
  const headerValue = getHeaderValue(req, ACCELERANT_BASE_URL_HEADER)?.trim();
  if (headerValue && isLoopbackBaseUrl(headerValue)) {
    return stripTrailingSlash(headerValue);
  }

  const envValue = process.env["OPENCLAW_ACCELERANT_API_URL"]?.trim();
  if (envValue) {
    return stripTrailingSlash(envValue);
  }

  const configValue = config.gateway?.controlUi?.accelerantApiBaseUrl?.trim();
  if (configValue) {
    return stripTrailingSlash(configValue);
  }

  return DEFAULT_ACCELERANT_BASE_URL;
}

/** Extract the `/accelerant/<subpath>` tail plus any query string. */
function resolveForwardTarget(baseUrl: string, rawUrl: string): string {
  // Parse against a dummy origin so we can separate pathname from search params
  // without depending on the inbound Host header.
  const parsed = new URL(rawUrl, "http://localhost");
  let subpath = parsed.pathname.slice(ACCELERANT_PATH_PREFIX.length);
  // The bare "/accelerant" path leaves no subpath; forward to the base root.
  if (parsed.pathname === ACCELERANT_PATH_ROOT) {
    subpath = "";
  }
  const suffix = subpath ? `/${subpath}` : "";
  return `${baseUrl}${suffix}${parsed.search}`;
}

/** Read and size-cap the raw request body for non-GET forwards. */
async function readRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; value: Buffer } | { ok: false; status: number; message: string }> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of req) {
      const buffer =
        typeof chunk === "string"
          ? Buffer.from(chunk)
          : Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk as Uint8Array);
      totalBytes += buffer.byteLength;
      if (totalBytes > maxBytes) {
        return { ok: false, status: 413, message: "Payload too large" };
      }
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, status: 400, message: "failed to read request body" };
  }
  return { ok: true, value: Buffer.concat(chunks) };
}

/** Coerce an unknown error into a printable message without leaking objects. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

/**
 * Handle one /accelerant/* request: authenticate, resolve the loopback base URL,
 * forward the method + JSON body to the ACCELERANT API, and relay the upstream
 * status + JSON body verbatim. Returns true once the response is written.
 */
export async function handleAccelerantHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: AccelerantHttpRequestOptions,
): Promise<boolean> {
  // Gateway auth: short-circuits to allowed when auth.mode === "none". Loopback-
  // direct callers (the same-origin Control UI on localhost) are trusted without a
  // token, mirroring the gateway's other local-direct exemptions — the proxied
  // ACCELERANT API is itself loopback-only, and isLocalDirectRequest only trusts a
  // direct loopback socket with no forwarded headers, so LAN/proxied requests still
  // require the gateway token.
  if (!isLocalDirectRequest(req, opts.trustedProxies, opts.allowRealIpFallback)) {
    const authorized = await authorizeGatewayHttpRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!authorized) {
      return true;
    }
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    res.setHeader("Allow", "GET, POST");
    sendJson(res, 405, { error: `Method Not Allowed: ${method}` });
    return true;
  }

  const baseUrl = resolveAccelerantBaseUrl(req, opts.config);
  // Defense-in-depth: even the env/config-sourced base URL must be loopback.
  // The contract default and the header path are already loopback; an operator
  // pointing OPENCLAW_ACCELERANT_API_URL elsewhere is rejected with a 400.
  if (!isLoopbackBaseUrl(baseUrl)) {
    sendJson(res, 400, {
      error: "ACCELERANT base URL must target a loopback host",
      baseUrl,
    });
    return true;
  }

  // Forward the JSON body for non-GET methods only. The body is decoded to a
  // UTF-8 string so it is a plain `BodyInit` regardless of the configured TS lib.
  let forwardBody: string | undefined;
  if (method !== "GET") {
    const body = await readRequestBody(req, MAX_ACCELERANT_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, body.status, { error: body.message });
      return true;
    }
    forwardBody = body.value.toString("utf8");
  }

  const targetUrl = resolveForwardTarget(baseUrl, req.url ?? ACCELERANT_PATH_ROOT);

  // Constrain egress to the configured loopback hostname only, and allow the
  // private network so the SSRF guard does not block 127.0.0.1/::1 targets.
  // Loopback is the intended trust boundary for this proxy.
  const allowedHostnamePolicy = ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl);
  const policy: SsrFPolicy = {
    ...(allowedHostnamePolicy ?? {}),
    allowPrivateNetwork: true,
  };

  const hasBody = forwardBody !== undefined && forwardBody.length > 0;
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (hasBody) {
    headers["content-type"] = "application/json";
  }

  const init: RequestInit = {
    method,
    headers,
    ...(hasBody ? { body: forwardBody } : {}),
  };

  let guarded: Awaited<ReturnType<typeof fetchWithSsrFGuard>> | undefined;
  try {
    guarded = await fetchWithSsrFGuard({
      url: targetUrl,
      init,
      policy,
      timeoutMs: ACCELERANT_FETCH_TIMEOUT_MS,
    });
  } catch (error) {
    sendJson(res, 502, {
      error: `ACCELERANT API unreachable: ${errorMessage(error)}`,
      baseUrl,
    });
    return true;
  }

  try {
    const upstream = guarded.response;
    const rawText = await upstream.text();
    // Relay the upstream status verbatim. The body is returned as JSON: if the
    // upstream sent valid JSON we forward its bytes unchanged, otherwise we wrap
    // the raw text so the Content-Type contract (application/json) always holds.
    res.statusCode = upstream.status;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (rawText.length === 0) {
      res.end("");
      return true;
    }
    try {
      // Validate JSON, then forward the original bytes unchanged.
      JSON.parse(rawText);
      res.end(rawText);
    } catch {
      res.end(JSON.stringify({ raw: rawText }));
    }
    return true;
  } catch (error) {
    sendJson(res, 502, {
      error: `ACCELERANT API unreachable: ${errorMessage(error)}`,
      baseUrl,
    });
    return true;
  } finally {
    await guarded.release();
  }
}
