import {
  handlePackageRequest,
  parseZipTOC,
  shouldFlattenFromTOC,
  hasRootMarkerInTOC
} from "./package-handler.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname || "/";
    const remoteUrl = url.searchParams.get("url");

    if (pathname === "/logs.json") {
      return handleLogsRequest(request, env);
    }

    const packageMatch = pathname.match(/^\/packages\/([^/]+)\/?$/);
    if (packageMatch) {
      if (!remoteUrl) return new Response("Missing ?url", { status: 400 });
      let name = packageMatch[1];
      try {
        name = decodeURIComponent(name);
      } catch {
        return new Response("Invalid package name", { status: 400 });
      }
      return handlePackageRequest({ request, env, ctx, remoteUrl, name });
    }

    if (pathname.startsWith("/packages")) {
      return new Response("Package name required in path", { status: 400 });
    }

    // Legacy root handler kept during migration
    if (pathname === "/" || pathname === "") {
      if (!remoteUrl) return new Response("Missing ?url", { status: 400 });
      const legacyName = url.searchParams.get("name");
      return handlePackageRequest({ request, env, ctx, remoteUrl, name: legacyName });
    }

    return new Response("Not found", { status: 404 });
  }
};

async function handleLogsRequest(request, env) {
  const assetUrl =
    env?.ASSET_URL ||
    "https://github.com/packagecontrol/thecrawl/releases/download/crawler-status/logs.json";

  const upstream = await fetch(assetUrl, {
    // Keep edge cache tiny; still allow edge to revalidate quickly.
    cf: { cacheTtl: 10, cacheEverything: true }
  });

  const headers = logResponseHeaders(upstream.headers, upstream.status);
  if (upstream.status === 200 && clientCacheIsFresh(request.headers, upstream.headers)) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

// Re-export for tests
export { parseZipTOC, shouldFlattenFromTOC, hasRootMarkerInTOC };

function logResponseHeaders(upstreamHeaders, status) {
  const headers = new Headers(upstreamHeaders);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=10, s-maxage=10");
  if (status === 200) {
    headers.set("Content-Type", "application/json; charset=utf-8");
    headers.delete("Content-Length");
    headers.delete("Content-Disposition");
  }
  return headers;
}

function clientCacheIsFresh(requestHeaders, upstreamHeaders) {
  const ifNoneMatch = requestHeaders.get("If-None-Match");
  if (ifNoneMatch) {
    const etag = upstreamHeaders.get("ETag");
    return Boolean(etag && etagMatches(ifNoneMatch, etag));
  }

  const ifModifiedSince = requestHeaders.get("If-Modified-Since");
  const lastModified = upstreamHeaders.get("Last-Modified");
  if (!ifModifiedSince || !lastModified) {
    return false;
  }

  const clientDate = Date.parse(ifModifiedSince);
  const upstreamDate = Date.parse(lastModified);
  return Number.isFinite(clientDate)
    && Number.isFinite(upstreamDate)
    && upstreamDate <= clientDate;
}

function etagMatches(ifNoneMatch, etag) {
  if (ifNoneMatch.trim() === "*") {
    return true;
  }

  const normalizedEtag = normalizeEtag(etag);
  return ifNoneMatch
    .split(",")
    .map(normalizeEtag)
    .includes(normalizedEtag);
}

function normalizeEtag(etag) {
  return etag.trim().replace(/^W\//i, "");
}
