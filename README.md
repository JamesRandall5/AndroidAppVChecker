# Android App Checker Render Minimal Test - Programmatic APKMirror Android TV build 1.0.9

This build keeps Google Play for metadata, then programmatically discovers APKMirror Android TV listing pages. It does not use package-specific APKMirror overrides or hard-coded app paths.

The important behaviour is:

- Google Play `VARY` is never returned as the final version.
- APKMirror URLs are discovered using title, developer, package name and Android TV search signals.
- APKMirror candidates are only accepted when the listing/candidate has Android TV signals.
- Android TV APKMirror candidates outrank generic/mobile fallbacks such as Aptoide JSON.

Health response should show:

```json
{
  "build": "android-tv-programmatic-apkmirror-tv-1.0.9",
  "provider_build": "google-play-provider-programmatic-apkmirror-tv-1.0.9"
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
