const express = require('express');
const { GooglePlayProvider } = require('./providers/google-play');

const port = Number(process.env.PORT || 10000);
const sharedSecret = String(process.env.CHECKER_SHARED_SECRET || '').trim();
const gplayCountry = String(process.env.GPLAY_COUNTRY || 'gb').trim();
const gplayLanguage = String(process.env.GPLAY_LANGUAGE || 'en').trim();
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const buildVersion = 'android-tv-vary-fallback-1.0.2';

if (!sharedSecret) {
  console.error('CHECKER_SHARED_SECRET is required');
  process.exit(1);
}

const app = express();
const provider = new GooglePlayProvider({
  country: gplayCountry,
  language: gplayLanguage,
  timeoutMs: requestTimeoutMs,
});

app.use(express.json({ limit: '1mb' }));

function requireBearer(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token !== sharedSecret) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }
  return next();
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'android-app-checker-render-test',
    source: 'Google Play + Android TV fallback',
    build: buildVersion,
    country: gplayCountry,
    language: gplayLanguage,
  });
});

app.post('/check-one', requireBearer, async (req, res) => {
  try {
    const packageName = String(req.body.package_name || '').trim();
    if (!packageName) {
      return res.status(400).json({ ok: false, error: 'package_name is required' });
    }

    const result = await provider.lookup(packageName);
    return res.status(result.ok ? 200 : 502).json({ build: buildVersion, ...result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || 'Unknown error',
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Listening on http://0.0.0.0:${port}`);
});
