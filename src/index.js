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

// Re-export for tests
export { parseZipTOC, shouldFlattenFromTOC, hasRootMarkerInTOC };
