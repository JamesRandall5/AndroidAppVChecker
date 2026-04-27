# Android App Checker Render Minimal Test - candidates build

This minimal Render service checks one Android package and returns every version candidate it can find.

It does **not** treat Google Play `VARY` as a real version. It keeps it as `google_play_version` / a candidate, then tries free public fallback sources.

Sources in this build:

1. Google Play via `google-play-scraper`
2. Aptoide JSON API `app/getMeta`
3. Aptoide JSON API `apps/search`
4. APKPure public HTML pages
5. Direct Google Play page parse
6. Aptoide public HTML pages

The response includes:

- `version` - the best usable version found, or `null`
- `source` - which source won
- `confidence` - rough confidence score
- `candidates` - all versions/errors found from each source

## GitHub files

Put these files in the root of the GitHub repo:

```text
package.json
server.js
render.yaml
.node-version
.env.example
.gitignore
README.md
providers/google-play.js
```

Do not upload `.env` or `node_modules`.

## Render env vars

```text
CHECKER_SHARED_SECRET=your-secret
GPLAY_COUNTRY=gb
GPLAY_LANGUAGE=en
REQUEST_TIMEOUT_MS=30000
NODE_VERSION=20.18.0
```

## Test

Deploy, then open:

```text
https://YOUR-SERVICE.onrender.com/health
```

The health response should include:

```json
"build": "android-tv-candidates-1.0.3"
```
