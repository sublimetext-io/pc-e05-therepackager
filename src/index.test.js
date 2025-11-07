import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import worker, { parseZipTOC, hasRootMarkerInTOC, shouldFlattenFromTOC } from "./index.js";

const fixturePath = (name) => path.resolve("test/fixtures", name);
const readFixture = (name) => fs.readFileSync(fixturePath(name));
const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;

describe("shouldFlattenFromTOC", () => {
  it("returns prefix when archive has a single root folder", () => {
    const toc = {
      entries: [
        { name: "plugin/", isDir: true },
        { name: "plugin/main.py", isDir: false },
        { name: "plugin/assets/icon.png", isDir: false }
      ],
      tops: new Set(["plugin"]),
      hasRootFiles: false
    };
    const result = shouldFlattenFromTOC(toc);
    expect(result).toEqual({ prefix: "plugin/" });
  });

  it("returns false when root contains files", () => {
    const toc = {
      entries: [
        { name: "main.py", isDir: false },
        { name: "readme.txt", isDir: false }
      ],
      tops: new Set(["main.py", "readme.txt"]),
      hasRootFiles: true
    };
    expect(shouldFlattenFromTOC(toc)).toBe(false);
  });

  it("returns false when multiple root folders exist", () => {
    const toc = {
      entries: [
        { name: "plugin/main.py", isDir: false },
        { name: "other/file.txt", isDir: false }
      ],
      tops: new Set(["plugin", "other"]),
      hasRootFiles: false
    };
    expect(shouldFlattenFromTOC(toc)).toBe(false);
  });
});

describe("hasRootMarkerInTOC", () => {
  it("detects marker at root", () => {
    const toc = { entries: [{ name: ".no-sublime-package", isDir: false }] };
    expect(hasRootMarkerInTOC(toc)).toBe(true);
  });

  it("ignores marker nested in subdirectory without strip", () => {
    const toc = { entries: [{ name: "nested/.no-sublime-package", isDir: false }] };
    expect(hasRootMarkerInTOC(toc)).toBe(false);
  });

  it("detects marker nested in subdirectory when stripping prefix", () => {
    const toc = { entries: [{ name: "nested/.no-sublime-package", isDir: false }] };
    expect(hasRootMarkerInTOC(toc, "nested/")).toBe(true);
  });
});

describe("real package fixtures", () => {
  it("MaxPane: flattens and uses .sublime-package", () => {
    const bytes = new Uint8Array(readFixture("MaxPane-master.zip"));
    const toc = parseZipTOC(bytes);
    const flatten = shouldFlattenFromTOC(toc);
    expect(flatten).toBeTruthy();
    expect(hasRootMarkerInTOC(toc, flatten.prefix)).toBe(false);
  });

  it("TreeSitter: flattens and uses .zip", () => {
    const bytes = new Uint8Array(readFixture("TreeSitter-1.8.1.zip"));
    const toc = parseZipTOC(bytes);
    const flatten = shouldFlattenFromTOC(toc);
    expect(flatten).toBeTruthy();
    expect(hasRootMarkerInTOC(toc, flatten.prefix)).toBe(true);
  });
});

describe("fetch handler", () => {
  let cacheMatch;
  let cachePut;

  beforeEach(() => {
    cacheMatch = vi.fn().mockResolvedValue(undefined);
    cachePut = vi.fn().mockResolvedValue(undefined);

    globalThis.caches = {
      default: {
        match: cacheMatch,
        put: cachePut
      }
    };
  });

  afterEach(() => {
    if (originalFetch === undefined) {
      delete globalThis.fetch;
    } else {
      globalThis.fetch = originalFetch;
    }

    if (originalCaches === undefined) {
      delete globalThis.caches;
    } else {
      globalThis.caches = originalCaches;
    }

    vi.restoreAllMocks();
  });

  it("returns a flattened .sublime-package archive when marker absent", async () => {
    const remoteUrl = "https://codeload.github.com/jisaacks/MaxPane/zip/master";
    globalThis.fetch = createFetchMock(
      remoteUrl,
      readFixture("MaxPane-master.zip")
    );

    const request = new Request(
      `https://worker.example/?url=${encodeURIComponent(remoteUrl)}&name=MaxPane`
    );
    const waitUntil = vi.fn();

    const response = await worker.fetch(
      request,
      { ALLOW_HOSTS: "codeload.github.com", MAX_ZIP_BYTES: "50000000" },
      { waitUntil }
    );

    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledWith(remoteUrl);
    expect(cacheMatch).toHaveBeenCalled();
    expect(cachePut).toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalled();

    const contentDisposition = response.headers.get("Content-Disposition");
    expect(contentDisposition).toContain('filename="MaxPane.sublime-package"');

    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(archive).toHaveProperty("max_pane.py");
    expect(Object.prototype.hasOwnProperty.call(archive, ".no-sublime-package")).toBe(false);
  });

  it("returns a flattened .zip archive when marker present", async () => {
    const remoteUrl = "https://codeload.github.com/sublime-treesitter/TreeSitter/zip/1.8.1";
    globalThis.fetch = createFetchMock(
      remoteUrl,
      readFixture("TreeSitter-1.8.1.zip")
    );

    const request = new Request(
      `https://worker.example/?url=${encodeURIComponent(remoteUrl)}&name=TreeSitter`
    );
    const waitUntil = vi.fn();

    const response = await worker.fetch(
      request,
      { ALLOW_HOSTS: "codeload.github.com", MAX_ZIP_BYTES: "50000000" },
      { waitUntil }
    );
  
    expect(response.status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledWith(remoteUrl);
    expect(cacheMatch).toHaveBeenCalled();
    expect(cachePut).toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalled();

    const contentDisposition = response.headers.get("Content-Disposition");
    expect(contentDisposition).toContain('filename="TreeSitter.zip"');

    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));
    expect(archive).toHaveProperty("load.py");
    expect(archive).toHaveProperty("src/build.py");
    expect(Object.prototype.hasOwnProperty.call(archive, ".no-sublime-package")).toBe(true);
  });

  it("rejects non-allowlisted host", async () => {
    const remoteUrl = "https://example.com/archive.zip";
    globalThis.fetch = createFetchMock(remoteUrl, new Uint8Array([1, 2, 3]));

    const request = new Request(
      `https://worker.example/?url=${encodeURIComponent(remoteUrl)}&name=X`
    );
    const waitUntil = vi.fn();

    const response = await worker.fetch(
      request,
      { ALLOW_HOSTS: "codeload.github.com" },
      { waitUntil }
    );

    expect(response.status).toBe(403);
  });

  it("rejects http scheme", async () => {
    const remoteUrl = "http://codeload.github.com/whatever.zip";
    const request = new Request(
      `https://worker.example/?url=${encodeURIComponent(remoteUrl)}&name=X`
    );
    const waitUntil = vi.fn();

    const response = await worker.fetch(
      request,
      { ALLOW_HOSTS: "codeload.github.com" },
      { waitUntil }
    );

    expect(response.status).toBe(400);
  });
});

function createFetchMock(url, file) {
  return vi.fn(async (input) => {
    if (input === url) {
      return new Response(file, { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
}
