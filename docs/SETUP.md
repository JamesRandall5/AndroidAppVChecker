# Render Setup

1. Create a GitHub repo.
2. Put the contents of this Render folder in the repo root.
3. Create a new Render Web Service from the repo.
4. Use:

```text
Build Command: npm install
Start Command: npm start
Health Check Path: /health
```

5. Add environment variables:

```text
CHECKER_SHARED_SECRET=the-same-secret-as-20i
GPLAY_COUNTRY=gb
GPLAY_LANGUAGE=en
REQUEST_TIMEOUT_MS=30000
NODE_VERSION=20.18.0
```

6. Deploy and test:

```text
https://YOUR-RENDER-SERVICE.onrender.com/health
```

The response should include build `android-tv-production-apkmirror-exact-url-safe-1.3.5`.


## 1.3.8

Stable variant/filter URL build. This removes the slow search fallback from 1.3.7 and checks only the exact APKMirror source URL supplied by 20i plus a single Jina reader fallback. Direct APKMirror fetches are capped at 6 seconds and Jina reader fetches are capped at 12 seconds, so 20i should receive JSON instead of timing out.

For apps such as Crunchyroll, use the APKMirror Android TV variant/filter URL as the source, for example:

```text
https://www.apkmirror.com/apk/crunchyroll-llc-2/crunchyroll-everything-anime-android-tv/variant-%7B%22minapi_slug%22%3A%22minapi-23%22%7D/
```

The resolver remains TV-safe: Android TV evidence is required, Fire TV is rejected, and generic/mobile versions are not selected.

## 1.3.9 notes
This build fixes the parser regression that could select a date fragment such as `2025.3.14` as a version. It also reads `Latest:` lines on APKMirror variant pages, which is needed for apps such as Crunchyroll where the latest Android TV version is exposed in the variant table rather than the normal all-versions block returned to Render.


## Android TV only / Google Play trusted mode

The `/check-one` endpoint now accepts `trust_google_play_version`. When true and Google Play exposes a real semantic version, the service can return that Google Play version as the confirmed latest version. Use this only for packages that are known to be Android TV only, because it intentionally bypasses the normal requirement for APKMirror/APKPure Android TV evidence.
