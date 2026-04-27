# Android App Checker Render Minimal Test - REAL candidates build 1.0.4

This is the corrected minimal Render test service.

The important code is in:

```text
providers/google-play.js
```

This build does the following:

1. Calls Google Play through `google-play-scraper` for metadata.
2. Treats `VARY` / `Varies with device` as **not usable**.
3. Tries direct Google Play HTML.
4. Tries Aptoide JSON `app/getMeta`.
5. Tries Aptoide JSON `apps/search`.
6. Tries APKPure HTML URLs.
7. Tries Aptoide public HTML pages.
8. Returns a `candidates` array so you can see every source attempted.

It will never return `version: "VARY"` as the final version. If no real version is found, it returns:

```json
{
  "ok": false,
  "version": null,
  "google_play_version": "VARY",
  "candidates": []
}
```

## GitHub files

Put exactly these files in the root of the repo:

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

Do not upload:

```text
.env
node_modules/
.DS_Store
```

## Render env vars

```text
CHECKER_SHARED_SECRET=your-secret
GPLAY_COUNTRY=gb
GPLAY_LANGUAGE=en
REQUEST_TIMEOUT_MS=30000
NODE_VERSION=20.18.0
```

## Health check

After deploy, open:

```text
https://YOUR-SERVICE.onrender.com/health
```

You should see:

```json
"build": "android-tv-real-candidates-1.0.4",
"provider_build": "google-play-provider-real-candidates-1.0.4"
```


## Build 1.0.6

This build ranks fallback candidates. If Google Play returns VARY, it does not pick the first usable result. It prefers the highest credible fallback version, then source quality. This is intended to fix cases such as Crunchyroll where Aptoide JSON returns 2.6.0 but an Android TV public page exposes 3.61.0.


## 1.0.6 candidate ranking note

This build fixes the Crunchyroll test case where Aptoide JSON returned `2.6.0` but Aptoide HTML and APKMirror public listings showed `3.61.0`. The service now collects all candidates first and ranks them by Android TV relevance/source quality before using version number as a tie-breaker.
