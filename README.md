# Android App Checker Render Minimal Test - APKMirror Android TV build 1.0.7

This build keeps Google Play for metadata, but when Google Play returns `VARY` it tries APKMirror Android TV listings before lower-confidence public fallbacks.

Health response should show:

```json
{
  "build": "android-tv-apkmirror-ranked-1.0.7",
  "provider_build": "google-play-provider-apkmirror-android-tv-ranked-1.0.7"
}
```

Required files in GitHub:

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

Do not commit `.env`, `node_modules/`, or `.DS_Store`.
