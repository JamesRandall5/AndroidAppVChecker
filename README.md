# Android TV Version Checker - Render Service

This is the production-ready test Render service for checking Android TV app versions.

It does **not** try to guess the APKMirror page. The 20i side sends:

- `package_name`
- `apkmirror_tv_url`

The final selected version must come from the supplied APKMirror Android TV listing URL. Google Play is used for metadata only.

## Required GitHub files

Put these files in the root of your Render GitHub repo:

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

Add these in Render > Environment:

```text
CHECKER_SHARED_SECRET=your-long-random-secret
GPLAY_COUNTRY=gb
GPLAY_LANGUAGE=en
REQUEST_TIMEOUT_MS=30000
NODE_VERSION=20.18.0
```

## Render settings

- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`

## Test endpoints

Health:

```text
GET /health
```

Check one app:

```text
POST /check-one
Authorization: Bearer YOUR_SECRET
Content-Type: application/json

{
  "package_name": "uk.co.uktv.dave",
  "apkmirror_tv_url": "https://www.apkmirror.com/apk/uktv-media-ltd/uktv-play-tv-shows-on-demand-android-tv/"
}
```

## Important behaviour

If APKMirror cannot be fetched or parsed, this service returns:

```json
{
  "ok": false,
  "status": "needs_review",
  "version": null
}
```

It will not fall back to a generic/mobile version, because that is how wrong results such as mobile app versions appear in an Android TV checker.

## Example APKMirror Android TV listing URLs

```text
Netflix:
https://www.apkmirror.com/apk/netflix-inc/netflix-android-tv/

Crunchyroll:
https://www.apkmirror.com/apk/crunchyroll-llc-2/crunchyroll-everything-anime-android-tv/

U / Dave / UKTV:
https://www.apkmirror.com/apk/uktv-media-ltd/uktv-play-tv-shows-on-demand-android-tv/
```

Use the app listing URL if possible, not an old release download URL. If a release URL is entered, the service tries to normalise it back to the app listing URL.
