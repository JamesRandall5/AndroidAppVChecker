const express = require('express');
const { AndroidTvVersionProvider, PROVIDER_BUILD } = require('./providers/google-play');

const port = Number(process.env.PORT || 10000);
const sharedSecret = String(process.env.CHECKER_SHARED_SECRET || '').trim();
const gplayCountry = String(process.env.GPLAY_COUNTRY || 'gb').trim();
const gplayLanguage = String(process.env.GPLAY_LANGUAGE || 'en').trim();
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const buildVersion = 'android-tv-production-version-source-safe-1.4.2';

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
    service: 'android-tv-version-checker-render',
    build: buildVersion,
    provider_build: PROVIDER_BUILD,
    country: gplayCountry,
    language: gplayLanguage,
    behaviour: 'Production service. Google Play metadata is collected. Final version normally comes from confirmed Android TV rows or links from the version source URL. If an app is marked Android TV only / trust Google Play version by 20i, a real Google Play version can be accepted when public Play exposes it.',
    endpoints: {
      check_one: 'POST /check-one { package_name, apkmirror_tv_url or version_source_url }',
    },
  });
});

app.post('/check-one', requireBearer, async (req, res) => {
  try {
    const packageName = String(req.body.package_name || '').trim();
    const apkMirrorTvUrl = String(req.body.apkmirror_tv_url || '').trim();
    const versionSourceUrl = String(req.body.version_source_url || '').trim();
    const trustGooglePlayVersion = req.body.trust_google_play_version === true || req.body.trust_google_play_version === 1 || req.body.trust_google_play_version === '1' || req.body.trust_google_play_version === 'true';

    if (!packageName) {
      return res.status(400).json({ ok: false, error: 'package_name is required' });
    }

    const result = await provider.lookup({ packageName, apkMirrorTvUrl, versionSourceUrl, trustGooglePlayVersion });

    // Return 200 even for needs_review/needs_source_setup so the 20i page can show the full diagnostics.
    return res.status(200).json({ build: buildVersion, provider_build: PROVIDER_BUILD, ...result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({
      ok: false,
      build: buildVersion,
      provider_build: PROVIDER_BUILD,
      error: error.message || 'Unknown error',
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Listening on http://0.0.0.0:${port}`);
});
