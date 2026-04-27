# Android App Checker Render Minimal Test - TV Safe Resolver 1.1.1

This Render service is the TV-safe resolver build.

It uses Google Play for metadata only, then tries to discover APKMirror Android TV listings programmatically.

Important behaviour:

- `VARY` is never returned as the final version.
- Generic/mobile fallback versions are never selected as final.
- A final result is returned only when there is Android TV evidence such as `(Android TV)`, `Requires Android TV`, `for Android TV`, or `android-tv` in an APKMirror listing URL/context.
- If no Android TV-confirmed version is found, the service returns `ok: false` and `version: null` rather than returning a wrong mobile version.

GitHub repo files:

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

Do not upload `.env`, `node_modules/`, or `.DS_Store`.
