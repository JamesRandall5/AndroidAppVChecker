# Android App Checker - Minimal Render Test with Android TV fallback

Commit these files/folders to GitHub:

- package.json
- server.js
- providers/google-play.js
- .node-version
- .env.example
- render.yaml
- README.md

Do not commit:

- .env
- node_modules/
- .DS_Store

Render build command: npm install
Render start command: npm start
Health check path: /health

## What changed in this version

Google Play can return version: VARY for apps where the Play Store page says “Varies with device”.
For Android TV app checking, that is not useful, so this build treats VARY as a missing version and tries Android-TV-specific fallback pages.

Fallback order:

1. Google Play scraper for title/developer/store metadata.
2. APKPure Android TV page, for example /download/tv.
3. Google Play page fallback.
4. Aptoide fallback.

For the Crunchyroll TV package, the service should now try APKPure TV pages after Google Play returns VARY.

## Files that must change from the previous build

If GitHub only shows README.md as changed, the code file was not replaced. The key file is:

- `providers/google-play.js`

You should also see these files changed in this build:

- `server.js` - adds `build: android-tv-vary-fallback-1.0.2` to `/health` and `/check-one` responses.
- `package.json` - bumps the test service version to `1.0.2`.
- `.gitignore` - prevents `.env` and `node_modules` being committed.

Do not upload a real `.env` file to GitHub. Use Render Environment Variables instead.
