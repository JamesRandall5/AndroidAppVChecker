# Android TV Version Checker - Render Service

This is the production Render checker used by the 20i dashboard.

It is intentionally **TV-safe**:

- Google Play is used for metadata only.
- The final version must come from the APKMirror Android TV listing URL supplied by the 20i app record.
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


## 1.3.2
Improves APKMirror Android TV parsing when direct APKMirror access is blocked. Adds Jina Search fallback parsing, fixes Google Play `VARY` cleaning, and preserves the TV-safe rule: generic/mobile versions are never selected as final.

## 1.3.2 variant-page update
This build keeps the TV-safe rule but also checks a bounded set of APKMirror Android TV variant pages, such as `variant-{"minapi_slug":"minapi-23"}`. This is needed for apps where APKMirror exposes the newest Android TV release inside a filtered variant page instead of the base listing text.
