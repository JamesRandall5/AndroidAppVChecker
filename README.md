# Android TV Version Checker - Render Service

This is the production Render checker used by the 20i dashboard.

It is intentionally **TV-safe**:

- Google Play is used for metadata only.
- The final version must come from the APKMirror source URL supplied by the 20i app record.
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


## 1.3.5
Improves APKMirror Android TV parsing when direct APKMirror access is blocked. Adds Jina Search fallback parsing, fixes Google Play `VARY` cleaning, and preserves the TV-safe rule: generic/mobile versions are never selected as final.

## Exact APKMirror source URLs

This build checks only the exact APKMirror URL supplied by 20i. The URL can be the normal Android TV listing page, a variant/filter page, or a specific release page. It does not crawl broad variant/search pages, so it should return quickly and avoid drifting onto mobile versions.

For apps where the normal listing page does not expose the latest version to Render, paste the APKMirror variant/filter URL that shows the latest Android TV version into the 20i APKMirror URL field.


## 1.3.5 fixes

- Rejects image filenames such as `57.png` and `2.png` as versions.
- Rejects date-like fragments such as `11.2026`.
- Selects higher-confidence APKMirror release URL candidates before broad reader text.
- Keeps the TV-safe rule: no generic/mobile version is selected.

## 1.3.8

Adds support for broader APKMirror source pages, including developer pages such as:

```text
https://www.apkmirror.com/apk/crunchyroll-llc-2/
```

The resolver is still TV-safe. It only accepts APKMirror release rows/links that contain Android TV, rejects Fire TV in any format, rejects generic/mobile rows, and selects the highest valid Android TV version found on the supplied source page.


## 1.3.8

Stable variant/filter URL build. This removes the slow search fallback from 1.3.7 and checks only the exact APKMirror source URL supplied by 20i plus a single Jina reader fallback. Direct APKMirror fetches are capped at 6 seconds and Jina reader fetches are capped at 12 seconds, so 20i should receive JSON instead of timing out.

For apps such as Crunchyroll, use the APKMirror Android TV variant/filter URL as the source, for example:

```text
https://www.apkmirror.com/apk/crunchyroll-llc-2/crunchyroll-everything-anime-android-tv/variant-%7B%22minapi_slug%22%3A%22minapi-23%22%7D/
```

The resolver remains TV-safe: Android TV evidence is required, Fire TV is rejected, and generic/mobile versions are not selected.

## 1.3.9
- Fixes APKMirror release-slug parsing so dates such as 2025.03.14 are not treated as app versions.
- Adds parsing for APKMirror variant/listing text such as `Latest: 3.61.0 on ...`.
- Supports versions with rc/beta/alpha suffixes, e.g. `26.6.0-rc5`.
- Keeps the Android TV only / no Fire TV / no mobile fallback rule.

## 1.4.0

Adds support for APKPure Android TV download pages as version sources. The 20i field can now contain either an APKMirror Android TV source URL or an APKPure TV download URL.

Example APKPure TV source:

```text
https://apkpure.com/crunchyroll/com.crunchyroll.crunchyroid/download/tv
```

The resolver only accepts APKPure results when the page/source has Android TV evidence and the package name matches the supplied app. APKMirror remains supported for apps where its listing is readable and clean.


## Android TV only / Google Play trusted mode

The `/check-one` endpoint now accepts `trust_google_play_version`. When true and Google Play exposes a real semantic version, the service can return that Google Play version as the confirmed latest version. Use this only for packages that are known to be Android TV only, because it intentionally bypasses the normal requirement for APKMirror/APKPure Android TV evidence.


## 1.4.4

- Fixes APKMirror/Jina reader parsing for Android TV app pages where the readable text contains a title/version such as `(Android TV) 10.12.5000` but does not repeat the APKMirror URL slug beside it.
- Adds same-app APKMirror variant-page fallbacks for Android TV app-listing URLs, so pages like Tubi can still resolve when the main listing is 403 or too thin via Jina.
- Keeps the existing TV-safe rules: Android TV evidence is still required, Fire TV is still rejected, and generic/mobile rows are still not selected.
