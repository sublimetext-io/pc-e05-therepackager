import { unzipSync, zipSync } from "fflate";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const remoteUrl = url.searchParams.get("url");
    const name = url.searchParams.get("name") || "Package";

    if (!remoteUrl) {
      return new Response("Missing ?url", { status: 400 });
    }

    // Security: validate and restrict remote URL
    const validation = validateUrl(remoteUrl, env);
    if (!validation.ok) return validation.response;

    // Use Cloudflare edge cache
    const cacheKey = new Request(request.url, request);
    const cache = caches.default;
    let response = await cache.match(cacheKey);
    if (response) return response;

    // Fetch upstream ZIP
    const res = await fetch(remoteUrl);
    // Enforce that the final URL still matches the allowlist (post-redirect)
    try {
      const finalHost = new URL(res.url || remoteUrl).hostname.toLowerCase();
      if (!validation.allowHosts.includes(finalHost)) {
        return new Response("Redirected host not permitted", { status: 403 });
      }
    } catch {}
    if (!res.ok) {
      return new Response(`Upstream error: ${res.status}`, { status: 502 });
    }
    // Limit download size to protect resources
    const maxBytes = Number(env?.MAX_ZIP_BYTES || 25_000_000);
    const data = await readLimited(res, maxBytes);
    if (!data.ok) {
      return new Response(data.message, { status: data.status });
    }
    const arrayBuffer = data.body.buffer;

    const files = unzipSync(new Uint8Array(arrayBuffer));
    let zipped;
    let useZipExtension;

    if (shouldFlatten(files)) {
      // Flatten the single root folder
      const first = Object.keys(files)[0];
      const prefix = first.split("/")[0] + "/";
      const newFiles = {};

      for (const [path, data] of Object.entries(files)) {
        if (!path.startsWith(prefix)) continue;
        const inner = path.slice(prefix.length);
        if (inner) newFiles[inner] = data;
      }

      zipped = zipSync(newFiles);
      useZipExtension = hasRootMarker(newFiles);
    } else {
      zipped = new Uint8Array(arrayBuffer);
      useZipExtension = hasRootMarker(files);
    }

    const extension = useZipExtension ? "zip" : "sublime-package";
    const filename = `${name}.${extension}`;

    response = new Response(zipped, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "public, max-age=31536000, immutable"
      }
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
};

/**
 * Determine if the ZIP archive consists of exactly one top-level folder
 * containing all files (no other root-level files), making it safe to flatten.
 *
 * @param {Record<string, Uint8Array>} files - Map of archive paths to file data.
 * @returns {boolean} True if flattening should be applied.
 */
export function shouldFlatten(files) {
  const paths = Object.keys(files);
  if (!paths.length) return false;

  let root = null;
  let hasNested = false;

  for (const rawPath of paths) {
    const path = rawPath.replace(/^\.\/+/g, "");
    if (!path) continue;

    const isDirectory = path.endsWith("/");
    const clean = path.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!clean) continue;

    const segments = clean.split("/");
    const top = segments[0];

    if (root === null) root = top;
    if (top !== root) return false;

    if (segments.length === 1 && !isDirectory) {
      return false;
    }

    if (segments.length > 1) hasNested = true;
  }

  return hasNested;
}

/**
 * Check whether the archive contains a `.no-sublime-package` marker file at
 * the root level indicating it must be unpacked on the client.
 *
 * @param {Record<string, Uint8Array>} files - Map of archive paths to file data.
 * @returns {boolean} True when the marker exists at the root.
 */
export function hasRootMarker(files) {
  const markerPattern = /^(?:\.\/|\/)?\.no-sublime-package$/;
  return Object.keys(files).some((rawPath) => markerPattern.test(rawPath));
}

/**
 * Validate the provided remote URL against protocol and allowlist rules.
 * Returns { ok: true, parsedRemote, allowHosts } on success, otherwise
 * { ok: false, response } ready to return from the handler.
 *
 * @param {string} remoteUrl
 * @param {{ ALLOW_HOSTS?: string }} env
 */
function validateUrl(remoteUrl, env) {
  const allowHosts = String(
    env?.ALLOW_HOSTS || "codeload.github.com,bitbucket.org,codelab.org,gitlab.com"
  )
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  let parsedRemote;
  try {
    parsedRemote = new URL(remoteUrl);
  } catch {
    return { ok: false, response: new Response("Invalid url parameter", { status: 400 }) };
  }

  if (parsedRemote.protocol !== "https:") {
    return { ok: false, response: new Response("Only https URLs are allowed", { status: 400 }) };
  }
  if (parsedRemote.username || parsedRemote.password) {
    return { ok: false, response: new Response("Credentials in URLs are not allowed", { status: 400 }) };
  }
  const host = parsedRemote.hostname.toLowerCase();
  if (isIpLiteral(host) || host === "localhost") {
    return { ok: false, response: new Response("IP/localhost targets are not allowed", { status: 400 }) };
  }
  if (!allowHosts.includes(host)) {
    return { ok: false, response: new Response("Host not permitted", { status: 403 }) };
  }

  return { ok: true, parsedRemote, allowHosts };
}

/**
 * Basic check to prevent IP/localhost targets
 */
function isIpLiteral(host) {
  // IPv4
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true;
  // IPv6 (very permissive)
  if (/^\[?[0-9a-fA-F:]+\]?$/.test(host)) return true;
  return false;
}

/**
 * Read response body enforcing a byte limit
 * Returns { ok: true, body: Uint8Array } or { ok: false, status, message }
 */
async function readLimited(res, maxBytes) {
  const len = res.headers.get("content-length");
  if (len && Number(len) > maxBytes) {
    return { ok: false, status: 413, message: "File too large" };
  }

  if (!res.body) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      return { ok: false, status: 413, message: "File too large" };
    }
    return { ok: true, body: new Uint8Array(ab) };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      received += value.byteLength;
      if (received > maxBytes) {
        try {
          reader.cancel();
        } catch {}
        return { ok: false, status: 413, message: "File too large" };
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, body: out };
}
