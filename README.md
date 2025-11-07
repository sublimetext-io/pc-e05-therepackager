# The Repackager

The Repackager is a tiny Cloudflare Worker that fetches a remote ZIP archive, peels off the top-level folder, and returns a ZIP (named after the requested package) that is ready to be installed as a Sublime Text `.sublime-package`. It uses the Workers edge cache to avoid processing the same source archive repeatedly.

If the original ZIP contains the marker file `.no-sublime-package` at its root, the suggested filename extension will be `.zip`.  In that case installing the file under "Installed Packages" would not work and users must unzip the file manually into their "Packages" folder.


## Run Locally


  ```bash
  npm install
  npm run start
  ```

  Wrangler will spin up a local dev server at the URL it prints (typically `http://127.0.0.1:8787`). Append the same `?url=` query you plan to use in production to exercise the worker locally.

  Example:

  http://localhost:8787/?url=https://codeload.github.com/michaelblyons/SublimeSyntax-USFM-Bible/zip/version/st3092/0.1.0&name=USFM%20Bible


## Run Tests

Continuously:

```bash
npm run test
```

Or just once:

```bash
npm run test -- run
```

## Deploy to Cloudflare

1. Authenticate once with `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN` in your environment).
2. Update `wrangler.toml` if you need a different worker name or other account-specific settings.
3. Publish the worker:

   ```bash
   npm run deploy
   ```

Wrangler will upload the bundled worker to your Cloudflare account. After the command completes, the printed URL is ready to serve requests like the example above.

## Troubleshooting

- The worker caches responses aggressively (`max-age=31536000`). If you need to invalidate the cache, request the worker with a different query string (for example, add `&cacheBust=timestamp`).
