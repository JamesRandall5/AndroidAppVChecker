# Android TV Version Checker - Render Service

This is the production Render checker used by the 20i dashboard.

It is intentionally **TV-safe**:

- Google Play is used for metadata only.
- The final version must come from the APKMirror Android TV source URL supplied by the 20i app record.
- If the supplied URL cannot be fetched or parsed as Android TV, the service returns `ok: false` and `version: null` rather than returning a generic/mobile version.

## Files for GitHub

Put these files at the root of your Render GitHub repo:

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

Do not commit:

```text
.env
node_modules/
.DS_Store
```

## Render environment variables

```text
CHECKER_SHARED_SECRET=use-the-same-secret-as-20i
GPLAY_COUNTRY=gb
GPLAY_LANGUAGE=en
REQUEST_TIMEOUT_MS=30000
NODE_VERSION=20.18.0
```

## Render settings

```text
Build Command: npm install
Start Command: npm start
Health Check Path: /health
```

## Endpoint

`POST /check-one`

Headers:

```text
Authorization: Bearer YOUR_SECRET
Content-Type: application/json
```

Body:

```json
{
  "package_name": "com.netflix.ninja",
  "apkmirror_tv_url": "https://www.apkmirror.com/apk/netflix-inc/netflix-android-tv/"
}
```

The 20i dashboard calls this endpoint for one app at a time when running all checks.


## 1.3.4
Improves APKMirror Android TV parsing when direct APKMirror access is blocked. Adds Jina Search fallback parsing, fixes Google Play `VARY` cleaning, and preserves the TV-safe rule: generic/mobile versions are never selected as final.

## Exact APKMirror source URLs

This build checks only the exact APKMirror URL supplied by 20i. The URL can be the normal Android TV listing page, a variant/filter page, or a specific release page. It does not crawl broad variant/search pages, so it should return quickly and avoid drifting onto mobile versions.

For apps where the normal listing page does not expose the latest version to Render, paste the APKMirror variant/filter URL that shows the latest Android TV version into the 20i APKMirror URL field.


## 1.3.4 fixes

- Rejects image filenames such as `57.png` and `2.png` as versions.
- Rejects date-like fragments such as `11.2026`.
- Selects higher-confidence APKMirror release URL candidates before broad reader text.
- Keeps the TV-safe rule: no generic/mobile version is selected.
