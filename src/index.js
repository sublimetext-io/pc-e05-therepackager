// repackage without decompression: parse central directory, strip a single root folder,
// rebuild a new ZIP by rewriting headers and copying the *compressed* data as-is.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const remoteUrl = url.searchParams.get("url");
    const name = url.searchParams.get("name") || "Package";

    if (!remoteUrl) {
      return new Response("Missing ?url", { status: 400 });
    }

    const validation = validateUrl(remoteUrl, env);
    if (!validation.ok) return validation.response;

    const cacheKey = new Request(request.url, request);
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return addTiming(cached, "cache;desc=hit");

    // 1) HEAD pre-check for size → redirect if too large
    const softLimit = Number(env?.MAX_ZIP_BYTES || 25_000_000);       // hard security cap
    const cpuLimit = Number(env?.CPU_REPACKAGE_BYTES || 12_000_000);  // soft cap for CPU-budget
    let head;
    try {
      head = await fetch(remoteUrl, { method: "HEAD" });
    } catch {
      // Some origins don’t like HEAD — fall back to GET path below.
    }
    const headLen = Number(head?.headers?.get("content-length") || 0);
    if (head && head.ok) {
      const finalHost = safeHost(head.url || remoteUrl);
      if (!validation.allowHosts.includes(finalHost)) {
        return new Response("Redirected host not permitted", { status: 403 });
      }
      if (headLen && headLen > softLimit) {
        return addTiming(Response.redirect(remoteUrl, 302), "reason;desc=size>hard");
      }
      if (headLen && headLen > cpuLimit) {
        return addTiming(Response.redirect(remoteUrl, 302), "reason;desc=size>cpu");
      }
    }

    // 2) GET with streaming cap; if we exceed limit → redirect (graceful).
    const res = await fetch(remoteUrl);
    const finalHost = safeHost(res.url || remoteUrl);
    if (!validation.allowHosts.includes(finalHost)) {
      return new Response("Redirected host not permitted", { status: 403 });
    }
    if (!res.ok) {
      return new Response(`Upstream error: ${res.status}`, { status: 502 });
    }

    const limited = await readLimited(res, softLimit);
    if (!limited.ok) {
      // hard limit → redirect rather than 413 (your requirement a)
      return addTiming(Response.redirect(remoteUrl, 302), "reason;desc=readLimited");
    }
    const bytes = limited.body; // Uint8Array

    // 3) Inspect ZIP central directory (no decompression) to decide flatten.
    let toc;
    try {
      toc = parseZipTOC(bytes);
    } catch (e) {
      // If it isn’t a ZIP, just pass-through.
      const passthru = buildDownloadResponse(bytes, name, "zip");
      ctx.waitUntil(cache.put(cacheKey, passthru.clone()));
      return addTiming(passthru, "path;desc=passthru-notzip");
    }

    const flatten = shouldFlattenFromTOC(toc);
    const rootMarkerPresent =
      hasRootMarkerInTOC(toc, flatten?.prefix ?? "");

    if (!flatten) {
      // No need to rewrite file names; just serve original as .sublime-package or .zip
      const ext = rootMarkerPresent ? "zip" : "sublime-package";
      const resp = buildDownloadResponse(bytes, name, ext);
      ctx.waitUntil(cache.put(cacheKey, resp.clone()));
      return addTiming(resp, "path;desc=original-structure");
    }

    // 4) Lossless flatten (no inflate/deflate): rewrite headers + copy compressed data.
    //    This keeps CPU tiny compared to unzip/rezip.
    let flattenedBytes;
    try {
      flattenedBytes = rebuildZipFlatten(bytes, toc, flatten.prefix);
    } catch (e) {
      // If anything goes sideways, gracefully redirect upstream (a)
      return addTiming(Response.redirect(remoteUrl, 302), "reason;desc=flatten-failed");
    }

    const ext = rootMarkerPresent ? "zip" : "sublime-package";
    const response = buildDownloadResponse(flattenedBytes, name, ext);
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return addTiming(response, "path;desc=flatten-lossless");
  }
};

// Named exports for tests
export { parseZipTOC, shouldFlattenFromTOC, hasRootMarkerInTOC };


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

function safeHost(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return ""; }
}

function addTiming(resp, metric) {
  const r = new Response(resp.body, resp);
  const prev = resp.headers.get("Server-Timing");
  r.headers.set("Server-Timing", prev ? `${prev}, ${metric}` : metric);
  return r;
}

function buildDownloadResponse(bytes, name, ext) {
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}.${ext}"`,
      "Cache-Control": "public, max-age=31536000, immutable"
    }
  });
}

/* ===================== ZIP parsing & rebuilding ===================== */

const SIG_EOCD = 0x06054b50;
const SIG_CEN  = 0x02014b50;
const SIG_LOC  = 0x04034b50;

/**
 * Parse a ZIP's central directory into a compact, non-inflating Table Of Contents (TOC).
 *
 * The parser scans from the end to locate the EOCD, iterates central directory
 * file headers, and for each entry peeks at the corresponding local file header
 * to compute the exact start offset of the compressed data. No file contents are
 * decompressed.
 *
 * Returned data is intentionally minimal and tailored for downstream helpers:
 * - shouldFlattenFromTOC(): decides if a single top-level directory can be stripped
 * - hasRootMarkerInTOC(): detects a root-level ".no-sublime-package" marker
 * - rebuildZipFlatten(): rewrites headers and copies compressed bytes as-is
 *
 * @param {Uint8Array} bytes - Full ZIP file bytes.
 * @returns {{
 *   entries: Array<{
 *     name: string,
 *     isDir: boolean,
 *     flags: number,
 *     method: number,
 *     modTime: number,
 *     modDate: number,
 *     crc32: number,
 *     compSize: number,
 *     uncompSize: number,
 *     locRelOffset: number,
 *     dataStart: number
 *   }>,
 *   tops: Set<string>,           // unique first path segments at archive root
 *   hasRootFiles: boolean        // true if any non-directory exists at root
 * }}
 * @throws {Error} If EOCD is not found or expected local headers are missing.
 */
function parseZipTOC(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find EOCD within last 66k + comment
  const maxScan = Math.min(bytes.byteLength, 0xFFFF + 22 + 1024);
  let eocdOff = -1;
  for (let i = bytes.byteLength - 22; i >= bytes.byteLength - maxScan; i--) {
    if (i < 0) break;
    if (view.getUint32(i, true) === SIG_EOCD) { eocdOff = i; break; }
  }
  if (eocdOff < 0) throw new Error("EOCD not found");

  const totalEntries = view.getUint16(eocdOff + 10, true);
  const cdSize       = view.getUint32(eocdOff + 12, true);
  const cdOffset     = view.getUint32(eocdOff + 16, true);
  const entries = [];

  let p = cdOffset;
  const decoder = new TextDecoder("utf-8");
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(p, true) !== SIG_CEN) break;

    const versionNeeded  = view.getUint16(p + 6, true);
    const flags          = view.getUint16(p + 8, true);
    const method         = view.getUint16(p + 10, true);
    const modTime        = view.getUint16(p + 12, true);
    const modDate        = view.getUint16(p + 14, true);
    const crc32          = view.getUint32(p + 16, true);
    const compSize       = view.getUint32(p + 20, true);
    const uncompSize     = view.getUint32(p + 24, true);
    const fnameLen       = view.getUint16(p + 28, true);
    const extraLen       = view.getUint16(p + 30, true);
    const commentLen     = view.getUint16(p + 32, true);
    const extAttrs       = view.getUint32(p + 36, true);
    const locRelOffset   = view.getUint32(p + 42, true);

    const nameBytes = bytes.subarray(p + 46, p + 46 + fnameLen);
    const name = decoder.decode(nameBytes);

    // Read local header to find data start (for copying compressed bytes)
    const lp = locRelOffset;
    if (view.getUint32(lp, true) !== SIG_LOC) throw new Error("LOC missing");
    const lfNameLen  = view.getUint16(lp + 26, true);
    const lfExtraLen = view.getUint16(lp + 28, true);
    const dataStart  = lp + 30 + lfNameLen + lfExtraLen;

    entries.push({
      name,
      isDir: name.endsWith("/"),
      flags,
      method,
      modTime, modDate,
      crc32, compSize, uncompSize,
      locRelOffset,
      dataStart
    });

    p += 46 + fnameLen + extraLen + commentLen;
  }

  // also gather top-level segments
  const tops = new Set();
  let hasRootFiles = false;
  for (const e of entries) {
    const parts = e.name.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.length === 0) continue;
    tops.add(parts[0]);
    if (!e.isDir && parts.length === 1) hasRootFiles = true;
  }

  return { entries, tops, hasRootFiles };
}

function shouldFlattenFromTOC(toc) {
  // exactly one top-level folder and no root files → safe to flatten
  if (toc.hasRootFiles) return false;
  if (toc.tops.size !== 1) return false;
  const [root] = toc.tops;
  return { prefix: root + "/" };
}

function hasRootMarkerInTOC(toc, stripPrefix = "") {
  const marker = ".no-sublime-package";
  const want = stripPrefix ? (stripPrefix + marker) : marker;
  for (const e of toc.entries) {
    if (!e.isDir && e.name === want) return true;
  }
  return false;
}

function rebuildZipFlatten(bytes, toc, stripPrefix) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");

  const fileEntries = [];
  for (const e of toc.entries) {
    if (e.isDir) continue;
    if (!e.name.startsWith(stripPrefix)) {
      // Shouldn't happen if shouldFlattenFromTOC() said OK
      throw new Error("entry outside prefix");
    }
    const newName = e.name.slice(stripPrefix.length);
    if (!newName) continue; // was the directory marker itself
    fileEntries.push({ ...e, newName });
  }

  // Build locals + remember offsets
  const parts = [];
  let offset = 0;
  const locals = [];

  for (const e of fileEntries) {
    const nameBytes = encoder.encode(e.newName);
    const utf8Flag = 1 << 11;
    const noDataDesc = ~(1 << 3);

    const flags = (e.flags | utf8Flag) & noDataDesc;
    const locHeader = new Uint8Array(30 + nameBytes.length); // no extra
    const v = new DataView(locHeader.buffer);

    v.setUint32(0, SIG_LOC, true);
    v.setUint16(4, 20, true);                // version needed
    v.setUint16(6, flags, true);             // general purpose bit flag
    v.setUint16(8, e.method, true);          // method (store/deflate)
    v.setUint16(10, e.modTime, true);
    v.setUint16(12, e.modDate, true);
    v.setUint32(14, e.crc32, true);
    v.setUint32(18, e.compSize, true);
    v.setUint32(22, e.uncompSize, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true);                // extra length

    locHeader.set(nameBytes, 30);

    parts.push(locHeader);
    offset += locHeader.length;

    const data = bytes.subarray(e.dataStart, e.dataStart + e.compSize);
    parts.push(data);
    const localHeaderOffset = offset - locHeader.length; // where we wrote it
    offset += data.length;

    locals.push({ e, newName: e.newName, nameBytes, localHeaderOffset, flags });
  }

  // Central Directory
  const cdStart = offset;
  for (const x of locals) {
    const { e, nameBytes, localHeaderOffset, flags } = x;
    const cen = new Uint8Array(46 + nameBytes.length); // no extra, no comment
    const v = new DataView(cen.buffer);

    v.setUint32(0, SIG_CEN, true);
    v.setUint16(4, 0x0314, true);           // version made by (3=Unix, 20)
    v.setUint16(6, 20, true);               // version needed
    v.setUint16(8, flags, true);
    v.setUint16(10, e.method, true);
    v.setUint16(12, e.modTime, true);
    v.setUint16(14, e.modDate, true);
    v.setUint32(16, e.crc32, true);
    v.setUint32(20, e.compSize, true);
    v.setUint32(24, e.uncompSize, true);
    v.setUint16(28, nameBytes.length, true);
    v.setUint16(30, 0, true);               // extra length
    v.setUint16(32, 0, true);               // file comment length
    v.setUint16(34, 0, true);               // disk number start
    v.setUint16(36, 0, true);               // internal attrs
    v.setUint32(38, 0, true);               // external attrs
    v.setUint32(42, localHeaderOffset, true);

    cen.set(nameBytes, 46);

    parts.push(cen);
    offset += cen.length;
  }

  const cdSize = offset - cdStart;

  // EOCD
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(4, 0, true);                // disk number
  ev.setUint16(6, 0, true);                // disk where CD starts
  ev.setUint16(8, locals.length, true);    // records on this disk
  ev.setUint16(10, locals.length, true);   // total records
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);               // comment length

  parts.push(eocd);
  offset += eocd.length;

  // concat
  const out = new Uint8Array(offset);
  let w = 0;
  for (const p of parts) { out.set(p, w); w += p.length; }
  return out;
}
