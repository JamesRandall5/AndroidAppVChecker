const express = require('express');
const { AndroidTvVersionProvider, PROVIDER_BUILD } = require('./providers/google-play');

const port = Number(process.env.PORT || 10000);
const sharedSecret = String(process.env.CHECKER_SHARED_SECRET || '').trim();
const gplayCountry = String(process.env.GPLAY_COUNTRY || 'gb').trim();
const gplayLanguage = String(process.env.GPLAY_LANGUAGE || 'en').trim();
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const buildVersion = 'android-tv-programmatic-apkmirror-tv-1.0.9';

if (!sharedSecret) {
  console.error('CHECKER_SHARED_SECRET is required');
  process.exit(1);
}

const app = express();
const provider = new AndroidTvVersionProvider({
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
    source: 'Google Play metadata + programmatic APKMirror Android TV discovery + public fallbacks',
    build: buildVersion,
    provider_build: PROVIDER_BUILD,
    country: gplayCountry,
    language: gplayLanguage,
    behaviour: 'No package-specific APKMirror overrides. APKMirror URLs are discovered programmatically and only Android TV candidates are allowed to outrank generic fallbacks.',
  });
});

app.post('/check-one', requireBearer, async (req, res) => {
  try {
    const packageName = String(req.body.package_name || '').trim();
    if (!packageName) {
      return res.status(400).json({ ok: false, error: 'package_name is required' });
    }

    const result = await provider.lookup(packageName);

    // Return 200 even when no usable version is found, so the 20i test page can show
    // the full candidates list instead of only showing a cURL/HTTP error.
    return res.status(200).json({ build: buildVersion, provider_build: PROVIDER_BUILD, ...result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      build: buildVersion,
      provider_build: PROVIDER_BUILD,
      error: error.message || 'Unknown error',
    });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Listening on http://0.0.0.0:${port}`);
});
