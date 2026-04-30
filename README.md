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


## 1.4.7

- Fixes the timeout risk introduced by the broad public-search fallback in 1.4.6.
- General Bing/DuckDuckGo search fallbacks are disabled because they can exceed the 45 second 20i -> Render request window.
- APKMirror direct/reader/variant fetches now use shorter timeouts.
- Adds a bounded Tubi-specific fallback source path when APKMirror blocks the Android TV page: APKPure's Tubi version-history page is checked and only the Tubi Android TV branch pattern `x.y.5xxx` is accepted.
- This is **not** a fixed Tubi version. The checker parses the newest matching branch version at check time, so future values like `10.16.5000` or `10.17.5001` would be selected when they appear.
- Generic/mobile Tubi versions such as `10.17.0` and `10.16.1` are ignored by that fallback.
- Fire TV remains rejected.

## 1.4.8

- Adds support for APKMirror developer pages such as `https://www.apkmirror.com/apk/tubi-tv/` as a valid version source.
- When an Android-TV-specific APKMirror app page is blocked, the checker now tries the same developer page before the APKPure fallback.
- The developer page parser only accepts rows/links with nearby `Android TV` evidence, rejects Fire TV rows, and ignores newer generic/mobile uploads from the same developer page.
- Stops additional fallback requests as soon as a confirmed Android TV candidate is found, keeping checks bounded and avoiding the 45-second timeout issue.

## 1.4.9

- Render-only update. No 20i/admin GUI changes are required.
- Moves the Tubi-specific APKPure version-history fallback before APKMirror page fetches, so Tubi checks do not wait on APKMirror security-verification pages first.
- The Tubi fallback intentionally does not require `Android TV` text from APKPure, because APKPure's Tubi history does not separate that label. It only accepts the Tubi TV branch pattern `x.y.5xxx` and ignores generic/mobile versions such as `x.y.z`.
- Supports using the APKPure Tubi versions page directly as the version source as well as using it as a fallback from APKMirror.


## 1.4.10

- Render-only update. No 20i/admin GUI changes are required.
- Keeps the Tubi-only APKPure fallback, but no longer relies only on the direct APKPure "/versions" page because Render can receive HTTP 403 from that URL.
- Adds bounded fallback checks for APKPure's old-version article/index text and one short Bing RSS index lookup, then applies the same Tubi branch rule.
- The Tubi rule still does not require "Android TV" text from APKPure. It accepts only x.y.5xxx branch versions and ignores generic/mobile x.y.z versions.
- Fallback requests use short per-target timeouts so the 20i request should receive JSON instead of hanging until the 45-second outer timeout.


## 1.4.11 APKFab support

Render now accepts APKFab version-history URLs such as `https://apkfab.com/tubi-free-movies-tv-shows/com.tubitv/versions`. For normal apps, APKFab remains TV-safe and only confirms a version when the APKFab source is TV-scoped. For Tubi (`com.tubitv`), APKFab does not label the Android TV branch, so the checker uses a controlled package-specific rule that accepts only `x.y.5xxx` rows and skips newer mobile `x.y.z` rows.


## 1.4.12 notes

- Adds a controlled APKPure branch fallback for GB News (`uk.gbnews.app`). APKPure lists the TV and mobile app versions together without an Android TV label, so the provider accepts only the `1.x` branch and ignores mobile `2.x.x` rows.
- Because APKPure lists old versions newest-first and legacy versions like `1.12` are numerically higher than the current TV branch `1.8`, the GB News fallback returns the first visible matching `1.x` row rather than sorting all `1.x` rows semantically.
- Keeps the Tubi/APKFab logic from 1.4.11 unchanged.
- No 20i/admin GUI change is required.


## 1.4.13 Aptoide support

Render now accepts Aptoide version-history URLs such as `https://gb-news-gb-news.en.aptoide.com/versions`.

For normal apps, Aptoide remains TV-safe and only confirms a version when the source page is TV-scoped. For GB News (`uk.gbnews.app`), Aptoide does not label the Android TV branch, so the checker uses the same controlled package-specific rule: accept only the first visible `1.x` row and ignore mobile `2.x.x` rows. No 20i/admin GUI change is required.

## 1.4.14 Tai Chi at Home branch support

Adds a controlled package-specific fallback for Tai Chi at Home (`io.odeum.learntaichi`). Aptoide/APKPure list the intended TV-style branch with versions such as `1.5.5` and `1.5.4` alongside unrelated/newer `3.x.x` rows, so the provider accepts only the latest `1.x.x` branch and ignores `3.x.x`.

Recommended source URL:

```
https://tai-chi-at-home.en.aptoide.com/versions
```

The APKPure download URL is also supported as a secondary source:

```
https://apkpure.com/tai-chi-at-home/io.odeum.learntaichi/download
```

## 1.4.17 Apple TV Android TV branch support

- Added package-specific branch filtering for `com.apple.atve.androidtv.appletv`.
- Apple TV source pages can expose the mobile `2.x.x` branch alongside the Android TV `1x.x.x` branch.
- The checker now accepts only `1x.x.x` versions for Apple TV, for example `16.2.0`, and rejects mobile `2.x.x` versions such as `2.4.1`.
- Existing Tubi, GB News and Tai Chi branch rules are unchanged.
