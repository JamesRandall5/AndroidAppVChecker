# Minimal Render service for Android app version lookup

This service exposes two endpoints:

- `GET /health`
- `POST /check-one`

## Local test

1. Copy `.env.example` to `.env`.
2. Set `CHECKER_SHARED_SECRET`.
3. Run:

```bash
npm install
npm start
```

4. Test:

```bash
curl http://localhost:10000/health
curl -X POST http://localhost:10000/check-one \
  -H "Authorization: Bearer your-secret" \
  -H "Content-Type: application/json" \
  -d '{"package_name":"com.crunchyroll.crunchyroid"}'
```
