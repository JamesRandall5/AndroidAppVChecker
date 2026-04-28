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


## 1.3.7 note

Adds a bounded APKMirror search-result fallback for cases where direct APKMirror fetches return 403 and the reader view does not expose Android TV rows. The fallback still only accepts results containing Android TV and rejects Fire TV/mobile rows.
