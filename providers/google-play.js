const PROVIDER_BUILD = 'google-play-provider-production-version-source-tv-safe-1.4.2';

const PLAY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const APKMIRROR_HOST_RE = /(^|\.)apkmirror\.com$/i;
const APKPURE_HOST_RE = /(^|\.)apkpure\.(?:com|net)$/i;
const ANDROID_TV_RE = /android[\s-]*tv|\(\s*android\s*tv\s*\)/i;
const FIRE_TV_RE = /fire[\s-]*tv|amazon\s*fire/i;

class AndroidTvVersionProvider {
  constructor({ language = 'en', country = 'gb', timeoutMs = 30000 } = {}) {
    this.language = String(language || 'en');
    this.country = String(country || 'gb');
    // Keep source fetches bounded so a single app can return diagnostics quickly.
    this.timeoutMs = Math.max(6000, Math.min(Number(timeoutMs || 18000), 18000));
    this.gplayModule = null;
  }

  async loadScraper() {
    if (this.gplayModule) return this.gplayModule;
    const imported = await import('google-play-scraper');
    this.gplayModule = imported.default || imported;
    return this.gplayModule;
  }

  async lookup({ packageName, apkMirrorTvUrl, versionSourceUrl, trustGooglePlayVersion = false }) {
    const candidates = [];
    const notes = [];
    const meta = {
      package_name: packageName,
      title: '',
      developer: '',
      updated: '',
      url: this.playUrl(packageName),
    };

    await this.safeAdd(candidates, notes, 'google-play-scraper', async () => {
      const gplay = await this.loadScraper();
      const app = await this.withTimeout(
        gplay.app({ appId: packageName, lang: this.language, country: this.country }),
        Math.min(8000, this.timeoutMs),
        'Google Play request timed out'
      );
      meta.title = String(app?.title || '');
      meta.developer = String(app?.developer || app?.developerName || '');
      meta.updated = this.normaliseUpdated(app?.updated || app?.released || '');
      meta.url = String(app?.url || this.playUrl(packageName));
      const version = this.cleanVersion(app?.version || '');
      const trustPlay = Boolean(trustGooglePlayVersion && this.isUsableVersion(version));
      return [this.candidate({
        source: 'google-play-scraper',
        version,
        updated: meta.updated,
        url: meta.url,
        usable: trustPlay,
        tv_confirmed: trustPlay,
        confidence: trustPlay ? 0.88 : 0,
        tv_evidence: trustPlay ? '20i app setting says this package is Android TV only, so the public Google Play version is trusted.' : '',
        note: trustPlay
          ? 'Google Play public version accepted because app is marked Android TV only in 20i.'
          : (this.isUsableVersion(version)
            ? 'Google Play exposed a public version, but final selection still requires Android TV evidence or the 20i Android TV only setting.'
            : `Google Play version was "${version || 'blank'}". This is metadata only.`),
      })];
    });

    let normalised;
    try {
      normalised = this.normaliseVersionSourceUrl(versionSourceUrl || apkMirrorTvUrl);
    } catch (error) {
      const playWinner = this.pickBestTvCandidate(candidates);
      if (playWinner && playWinner.source === 'google-play-scraper') {
        return {
          ok: true,
          status: 'confirmed_android_tv_version',
          ...meta,
          version: playWinner.version,
          version_code: playWinner.version_code || '',
          google_play_version: playWinner.version,
          source: playWinner.source,
          source_url: playWinner.url || meta.url,
          apk_mirror_tv_url: '',
          version_source_url: '',
          confidence: playWinner.confidence,
          tv_evidence: playWinner.tv_evidence,
          selected_reason: 'Selected the Google Play public version because the app is marked Android TV only in 20i.',
          warning: this.summary(candidates.filter(c => c !== playWinner), notes),
          candidates,
          source_debug: {
            source_kind: 'google-play-trusted',
            source_url: meta.url,
            source_has_tv_hint: true,
            top_versions_seen: [{ version: playWinner.version, url: playWinner.url, tv: true, note: playWinner.note }],
            rejected_mobile_fire_tv_policy: 'Google Play accepted only because 20i says this package is Android TV only.',
          },
        };
      }
      return this.failure(meta, candidates, notes, 'needs_source_setup', error.message || 'Version source URL required.', '');
    }

    if (normalised.source_type === 'apkmirror') {
      await this.safeAdd(candidates, notes, 'apkmirror-source-url', () => this.lookupApkMirrorSource(normalised, meta));
    } else if (normalised.source_type === 'apkpure') {
      await this.safeAdd(candidates, notes, 'apkpure-tv-url', () => this.lookupApkPureSource(normalised, meta, packageName));
    } else {
      return this.failure(meta, candidates, notes, 'needs_source_setup', 'Unsupported version source URL.', normalised.source_url || '');
    }

    const winner = this.pickBestTvCandidate(candidates);
    if (winner) {
      return {
        ok: true,
        status: 'confirmed_android_tv_version',
        ...meta,
        version: winner.version,
        version_code: winner.version_code || '',
        google_play_version: candidates.find(c => c.source === 'google-play-scraper')?.version || null,
        source: winner.source,
        source_url: winner.url || normalised.source_url,
        apk_mirror_tv_url: normalised.source_url,
        version_source_url: normalised.source_url,
        confidence: winner.confidence,
        tv_evidence: winner.tv_evidence,
        selected_reason: 'Selected the highest confirmed Android TV version from the version source URL supplied by 20i. Fire-TV and generic/mobile rows were rejected.',
        warning: this.summary(candidates.filter(c => c !== winner), notes),
        candidates,
        source_debug: this.sourceDebug(candidates, normalised),
      };
    }

    return this.failure(
      meta,
      candidates,
      notes,
      'needs_review',
      'No confirmed Android TV version could be parsed from the supplied version source URL. Fire-TV and generic/mobile versions were not selected.',
      normalised.source_url,
      normalised
    );
  }

  async lookupApkMirrorSource(normalised, meta = {}) {
    // Production-safe behaviour: fetch only the exact source URL supplied by 20i.
    // The source may be:
    //   /apk/{developer}/                      developer page with multiple apps
    //   /apk/{developer}/{app}/                Android TV app listing page
    //   /apk/{developer}/{app}/{release}/      specific Android TV release page
    //   /uploads/?appcategory=...              APKMirror uploads category page
    // We do not crawl away from this source. We only parse Android TV release links/rows on the fetched page.
    const sourceUrl = normalised.source_url;
    const targets = [
      { method: 'direct-source-url', url: sourceUrl, confidence: 0.99, kind: 'html', timeout: 6000 },
      { method: 'jina-reader-source-url', url: `https://r.jina.ai/${sourceUrl}`, confidence: 0.97, kind: 'reader', timeout: 12000 },
    ];
    const out = [];

    for (const target of targets) {
      try {
        const text = await this.fetchText(target.url, {
          'User-Agent': PLAY_UA,
          'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
          Accept: target.kind === 'reader'
            ? 'text/plain,*/*;q=0.8'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain,*/*;q=0.8',
          Referer: 'https://www.google.com/',
        }, target.timeout);
        const parsed = this.extractTvCandidates(text, normalised, target, meta);
        if (parsed.length) out.push(...parsed);
        else out.push(this.candidate({ source: 'apkmirror-source-url', url: target.url, error: `${target.method}: fetched but no Android TV release row/link parsed` }));
      } catch (error) {
        out.push(this.candidate({ source: 'apkmirror-source-url', url: target.url, error: `${target.method}: ${error.message || 'fetch failed'}` }));
      }
    }

    return out;
  }

  async lookupApkPureSource(normalised, meta = {}, packageName = '') {
    const sourceUrl = normalised.source_url;
    const alternateUrl = normalised.alternate_url || '';
    const targets = [
      { method: 'direct-source-url', url: sourceUrl, confidence: 0.96, kind: 'html', timeout: 7000 },
      { method: 'jina-reader-source-url', url: `https://r.jina.ai/${sourceUrl}`, confidence: 0.94, kind: 'reader', timeout: 12000 },
    ];
    if (alternateUrl && alternateUrl !== sourceUrl) {
      targets.push({ method: 'direct-alternate-url', url: alternateUrl, confidence: 0.93, kind: 'html', timeout: 7000 });
      targets.push({ method: 'jina-reader-alternate-url', url: `https://r.jina.ai/${alternateUrl}`, confidence: 0.91, kind: 'reader', timeout: 12000 });
    }

    const out = [];
    for (const target of targets) {
      try {
        const text = await this.fetchText(target.url, {
          'User-Agent': PLAY_UA,
          'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
          Accept: target.kind === 'reader'
            ? 'text/plain,*/*;q=0.8'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain,*/*;q=0.8',
          Referer: 'https://www.google.com/',
        }, target.timeout);
        const parsed = this.extractApkPureTvCandidates(text, normalised, target, meta, packageName);
        if (parsed.length) { out.push(...parsed); return out; }
        else out.push(this.candidate({ source: 'apkpure-tv-url', url: target.url, error: `${target.method}: fetched but no Android TV version parsed` }));
      } catch (error) {
        out.push(this.candidate({ source: 'apkpure-tv-url', url: target.url, error: `${target.method}: ${error.message || 'fetch failed'}` }));
      }
    }
    return out;
  }

  extractApkPureTvCandidates(text, normalised, target, meta = {}, packageName = '') {
    const raw = String(text || '');
    const plain = this.toPlainText(raw).replace(/\s+/g, ' ').trim();
    const out = [];
    const seen = new Set();
    const packageOk = !packageName || plain.includes(packageName) || normalised.source_url.includes(packageName);
    const tvOk = normalised.source_has_tv_hint || /for\s+Android\s+TV|Android\s+TV/i.test(plain);
    if (!packageOk || !tvOk || this.isFireTvContext(plain)) return out;

    const patterns = [
      /What'?s\s+New\s+in\s+the\s+Latest\s+Version\s+([0-9]+(?:\.[0-9]+){1,5}(?:[-+](?:rc|beta|alpha)\d*)?)(?:\s*\((\d{2,})\))?/gi,
      /Download\s+APK\s+([0-9]+(?:\.[0-9]+){1,5}(?:[-+](?:rc|beta|alpha)\d*)?)(?:\s*\((\d{2,})\))?/gi,
      /\bVersion\s+([0-9]+(?:\.[0-9]+){1,5}(?:[-+](?:rc|beta|alpha)\d*)?)(?:\s*\((\d{2,})\))?/gi,
      /\b([0-9]+(?:\.[0-9]+){1,5}(?:[-+](?:rc|beta|alpha)\d*)?)\s*\((\d{2,})\)\s+(?:XAPK|APK|APKs|APK\s+Bundle)/gi,
      /Latest\s+Version\s+([0-9]+(?:\.[0-9]+){1,5}(?:[-+](?:rc|beta|alpha)\d*)?)/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(plain))) {
        const version = this.cleanVersion(match[1]);
        const version_code = match[2] || '';
        if (!this.isUsableVersion(version)) continue;
        const key = `${version}:${version_code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(this.candidate({
          source: 'apkpure-tv-url',
          version,
          version_code,
          updated: this.updatedFromText(plain),
          url: target.url,
          usable: true,
          tv_confirmed: true,
          confidence: target.confidence,
          tv_evidence: `APKPure TV page contains Android TV evidence and matching package/source (${target.method}).`,
          note: `Parsed APKPure Android TV version via ${target.method}.`,
        }));
      }
    }
    return this.uniqueBy(out, c => `${c.version}:${c.version_code}:${c.url}`);
  }

  extractTvCandidates(text, normalised, target, meta = {}) {
    const body = String(text || '');
    const plain = this.toPlainText(body);
    const out = [];
    const seen = new Set();

    // 1) Strongest signal: APKMirror release URLs. These are safer than generic text because
    //    the app/release slug itself can prove Android TV and provides the version.
    for (const item of this.extractReleaseUrls(body, normalised)) {
      const context = this.toPlainText(this.contextAround(body, item.raw, 800));
      const combined = `${item.absolute_url} ${item.app_slug} ${item.release_slug} ${item.raw}`;
      if (!this.isConfirmedAndroidTvContext(combined)) continue;
      if (this.isFireTvContext(combined)) continue;
      if (!this.sourceScopeAllowsRelease(item, normalised, meta)) continue;

      const info = this.versionFromReleaseSlug(item.release_slug, item.app_slug);
      if (!this.isUsableVersion(info.version)) continue;
      const key = `${info.version}:${info.version_code || ''}:${item.absolute_url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push(this.candidate({
        source: 'apkmirror-source-url',
        version: info.version,
        version_code: info.version_code || '',
        updated: this.updatedFromText(context),
        url: item.absolute_url,
        usable: true,
        tv_confirmed: true,
        confidence: target.confidence,
        tv_evidence: `APKMirror release URL/title contains Android TV (${target.method}).`,
        note: `Parsed APKMirror Android TV release link via ${target.method}.`,
      }));
    }

    // 2) Specific release/variant page fallback. If the supplied source itself is an Android TV
    //    release or variant/filter URL, parse versions from the exact page text. This is intentionally
    //    bounded: no search crawling, no broad variant discovery, and no generic/mobile final result.
    if ((normalised.is_release_url || normalised.is_variant_url) && normalised.source_has_tv_hint && !this.isFireTvContext(normalised.source_url)) {
      const exactInfos = normalised.is_release_url
        ? [this.versionFromReleaseSlug(normalised.release_slug, normalised.app_slug || '')]
        : this.versionCandidatesFromVariantText(plain);
      for (const info of exactInfos) {
        if (!this.isUsableVersion(info.version)) continue;
        const key = `${info.version}:${info.version_code || ''}:${normalised.source_url}:exact`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(this.candidate({
          source: 'apkmirror-source-url',
          version: info.version,
          version_code: info.version_code || '',
          updated: this.updatedFromText(plain),
          url: normalised.source_url,
          usable: true,
          tv_confirmed: true,
          confidence: Math.min(target.confidence, normalised.is_variant_url ? 0.96 : 0.95),
          tv_evidence: `Supplied APKMirror source URL is an Android TV ${normalised.is_variant_url ? 'variant/filter' : 'release'} URL.`,
          note: `Parsed exact APKMirror Android TV source URL via ${target.method}.`,
        }));
      }
    }

    // 3) Structured reader line fallback. This only accepts lines where Android TV is adjacent to
    //    a semantic version and Fire TV is absent. It does not accept image filenames, dates, etc.
    const lines = plain.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      const chunk = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 5)).join(' ');
      if (!this.isConfirmedAndroidTvContext(chunk)) continue;
      if (this.isFireTvContext(chunk)) continue;
      if (this.isApkMirrorNoiseChunk(chunk)) continue;
      if (!this.textScopeAllowsChunk(chunk, normalised, meta)) continue;

      const info = this.versionFromAndroidTvLine(chunk);
      if (!this.isUsableVersion(info.version)) continue;
      const key = `${info.version}:${info.version_code || ''}:${target.url}:line`;
      if (seen.has(key)) continue;
      seen.add(key);

      out.push(this.candidate({
        source: 'apkmirror-source-url',
        version: info.version,
        version_code: info.version_code || '',
        updated: this.updatedFromText(chunk),
        url: target.url,
        usable: true,
        tv_confirmed: true,
        confidence: Math.min(target.confidence, 0.90),
        tv_evidence: `Reader text line contains Android TV and a semantic version (${target.method}).`,
        note: `Parsed APKMirror Android TV reader text via ${target.method}.`,
      }));
    }

    return this.uniqueBy(out, c => `${c.source}:${c.version}:${c.version_code}:${c.url}`);
  }

  extractReleaseUrls(text, normalised) {
    const out = [];
    const pattern = /(?:href=["']([^"']+)["']|https?:\/\/www\.apkmirror\.com\/apk\/[^\s"'<>\)\]]+)/gi;
    let match;
    while ((match = pattern.exec(String(text || '')))) {
      const raw = match[1] || match[0];
      let absolute;
      try { absolute = new URL(raw.replace(/^href=["']?/i, ''), normalised.source_url); } catch (_) { continue; }
      if (!APKMIRROR_HOST_RE.test(absolute.hostname)) continue;
      const parts = absolute.pathname.split('/').filter(Boolean);
      if (parts.length < 4 || parts[0] !== 'apk') continue;
      const developerSlug = parts[1];
      const appSlug = parts[2];
      const releaseSlug = parts[3];
      if (!developerSlug || !appSlug || !releaseSlug || /^variant-/i.test(releaseSlug)) continue;
      if (!/\d/.test(releaseSlug)) continue;

      // Stay inside the supplied APKMirror scope. Developer page may include all apps by that developer;
      // app/release page must stay under that app slug.
      if (normalised.developer_slug && developerSlug !== normalised.developer_slug) continue;
      if (normalised.app_slug && appSlug !== normalised.app_slug) continue;

      out.push({
        raw,
        developer_slug: developerSlug,
        app_slug: appSlug,
        release_slug: releaseSlug,
        absolute_url: `${absolute.origin}/${parts.slice(0, 4).join('/')}/`,
      });
    }
    return this.uniqueBy(out, item => item.absolute_url);
  }

  normaliseVersionSourceUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Version source URL is required for TV-safe checking.');
    let url;
    try { url = new URL(raw); } catch (_) { throw new Error('Version source URL is not a valid URL.'); }
    if (APKMIRROR_HOST_RE.test(url.hostname)) return this.normaliseApkMirrorSourceUrl(raw);
    if (APKPURE_HOST_RE.test(url.hostname)) return this.normaliseApkPureSourceUrl(raw);
    throw new Error('Version source URL must be on apkmirror.com, apkpure.com, or apkpure.net.');
  }

  normaliseApkPureSourceUrl(input) {
    const raw = String(input || '').trim();
    let url;
    try { url = new URL(raw); } catch (_) { throw new Error('APKPure source URL is not a valid URL.'); }
    if (!APKPURE_HOST_RE.test(url.hostname)) throw new Error('APKPure source URL must be on apkpure.com or apkpure.net.');
    const sourceUrl = `https://${url.hostname}${url.pathname}${url.search || ''}`;
    const altHost = url.hostname.endsWith('.com') || url.hostname === 'apkpure.com'
      ? url.hostname.replace(/apkpure\.com$/i, 'apkpure.net')
      : url.hostname.replace(/apkpure\.net$/i, 'apkpure.com');
    const alternateUrl = `https://${altHost}${url.pathname}${url.search || ''}`;
    const parts = url.pathname.split('/').filter(Boolean);
    const packageFromPath = parts.find(part => /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/i.test(part)) || '';
    const isTvDownload = /\/download\/tv\/?$/i.test(url.pathname) || url.pathname.toLowerCase().includes('/download/tv');
    return {
      source_type: 'apkpure',
      kind: isTvDownload ? 'apkpure-tv-download' : 'apkpure',
      source_url: sourceUrl,
      alternate_url: alternateUrl,
      developer_slug: '',
      app_slug: parts[0] || '',
      release_slug: '',
      package_from_path: packageFromPath,
      original_url: raw,
      is_variant_url: false,
      is_release_url: false,
      source_has_tv_hint: isTvDownload || /android[-\s]*tv/i.test(sourceUrl),
    };
  }

  normaliseApkMirrorSourceUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('APKMirror source URL is required for TV-safe checking.');
    let url;
    try { url = new URL(raw); } catch (_) { throw new Error('APKMirror source URL is not a valid URL.'); }
    if (!APKMIRROR_HOST_RE.test(url.hostname)) throw new Error('Version source URL must be on apkmirror.com.');

    const parts = url.pathname.split('/').filter(Boolean);

    // Support APKMirror uploads category pages, e.g. /uploads/?appcategory=netflix-android-tv.
    if (parts[0] === 'uploads') {
      const category = String(url.searchParams.get('appcategory') || '').trim();
      return {
        source_type: 'apkmirror',
        kind: 'uploads',
        listing_url: `https://www.apkmirror.com/uploads/?appcategory=${encodeURIComponent(category)}`,
        source_url: `https://www.apkmirror.com/uploads/${url.search || ''}`,
        developer_slug: '',
        app_slug: category || '',
        release_slug: '',
        original_url: raw,
        is_variant_url: false,
        is_release_url: false,
        source_has_tv_hint: ANDROID_TV_RE.test(`${category} ${raw}`),
      };
    }

    if (parts[0] !== 'apk' || parts.length < 2) {
      throw new Error('Version source URL must be under /apk/{developer}/, /apk/{developer}/{app}/, or /uploads/?appcategory=...');
    }

    const developerSlug = parts[1];
    const appSlug = parts[2] || '';
    const releaseSlug = parts[3] || '';
    const cleanPath = `/${parts.join('/')}/`;
    const sourceUrl = `https://www.apkmirror.com${cleanPath}${url.search || ''}`;
    const lowerSource = sourceUrl.toLowerCase();
    return {
      source_type: 'apkmirror',
      kind: appSlug ? (/^variant-/i.test(releaseSlug) || /variant/i.test(url.search) ? 'variant' : (releaseSlug ? 'release' : 'app')) : 'developer',
      listing_url: appSlug ? `https://www.apkmirror.com/apk/${developerSlug}/${appSlug}/` : `https://www.apkmirror.com/apk/${developerSlug}/`,
      source_url: sourceUrl,
      developer_slug: developerSlug,
      app_slug: appSlug,
      release_slug: releaseSlug,
      original_url: raw,
      is_variant_url: /\/variant-/i.test(url.pathname) || /variant/i.test(url.search),
      is_release_url: Boolean(releaseSlug) && !/^variant-/i.test(releaseSlug),
      source_has_tv_hint: ANDROID_TV_RE.test(lowerSource) || ANDROID_TV_RE.test(appSlug) || ANDROID_TV_RE.test(releaseSlug),
    };
  }

  sourceScopeAllowsRelease(item, normalised, meta = {}) {
    const combined = `${item.app_slug} ${item.release_slug} ${item.absolute_url}`;
    if (this.isFireTvContext(combined)) return false;
    if (!this.isConfirmedAndroidTvContext(combined)) return false;

    // App/release sources are already scoped to a single app slug by extractReleaseUrls.
    if (normalised.kind === 'app' || normalised.kind === 'release') return true;

    // Upload category source should remain on the requested category if provided.
    if (normalised.kind === 'uploads' && normalised.app_slug) {
      return item.app_slug === normalised.app_slug || item.release_slug.includes(normalised.app_slug);
    }

    // Developer pages can list several apps. Generic rule: accept only app/release paths with Android TV
    // and prefer rows that share title tokens where possible, but don't hard-code any app name.
    if (normalised.kind === 'developer') {
      const titleTokens = this.importantTokens(meta.title || '');
      if (!titleTokens.length) return true;
      const haystack = `${item.app_slug} ${item.release_slug}`.toLowerCase();
      const hits = titleTokens.filter(t => haystack.includes(t)).length;
      // Require at least one meaningful title token when available so we do not select another Android TV app
      // from the same developer page by accident.
      return hits >= 1;
    }

    return true;
  }

  textScopeAllowsChunk(chunk, normalised, meta = {}) {
    const text = String(chunk || '');

    // APKMirror/Jina reader pages sometimes expose the app title and version as plain
    // text, for example: "Tubi: Free Movies & Live TV (Android TV) 10.12.5000".
    // In that format the human title is present but the APKMirror slug is not, so the
    // old slug-only scope check rejected valid Android TV app pages. This keeps the
    // TV-safe rule intact: the supplied source URL must already be Android TV scoped,
    // the chunk itself must say Android TV next to a real version, and Fire TV is still
    // rejected before any final candidate can be selected.
    if ((normalised.kind === 'app' || normalised.kind === 'release') && normalised.source_has_tv_hint) {
      const hasAdjacentTvVersion = this.isConfirmedAndroidTvContext(text)
        && /(?:\(\s*Android\s*TV\s*\)|Android\s*TV)[^0-9]{0,160}[0-9]+(?:\.[0-9]+){1,5}/i.test(text)
        && !this.isFireTvContext(text)
        && !this.isApkMirrorNoiseChunk(text);
      if (hasAdjacentTvVersion) return true;
    }

    if (normalised.kind === 'app' || normalised.kind === 'release') return this.lineBelongsToListing(chunk, normalised.app_slug);
    if (normalised.kind === 'uploads') return !normalised.app_slug || this.lineBelongsToListing(chunk, normalised.app_slug);
    if (normalised.kind === 'developer') {
      const tokens = this.importantTokens(meta.title || '');
      if (!tokens.length) return true;
      const haystack = String(chunk || '').toLowerCase();
      return tokens.some(t => haystack.includes(t));
    }
    return true;
  }

  versionFromReleaseSlug(releaseSlug, appSlug = '') {
    let rest = String(releaseSlug || '').toLowerCase();
    const slug = String(appSlug || '').toLowerCase();
    if (slug && rest.startsWith(`${slug}-`)) rest = rest.slice(slug.length + 1);
    rest = rest.replace(/-android-apk.*$/, '').replace(/-apk.*$/, '').replace(/-release$/, '');
    const buildMatch = rest.match(/(?:^|-)build-(\d{2,})/i);
    if (buildMatch) rest = rest.slice(0, buildMatch.index);

    // APKMirror slugs often end with a release date, e.g. 26-6-0rc5-2026-04-21.
    // Pick the first real semantic version after the app slug, not the trailing date.
    const match = rest.match(/(?:^|-)(\d+(?:-\d+){1,5})(?:(rc|beta|alpha)(\d*))?(?=$|-)/i);
    if (!match) return { version: '', version_code: buildMatch?.[1] || '' };
    const main = this.hyphenVersionToDotted(match[1]);
    const suffix = match[2] ? `-${String(match[2]).toLowerCase()}${match[3] || ''}` : '';
    return { version: `${main}${suffix}`, version_code: buildMatch?.[1] || '' };
  }

  versionFromAndroidTvLine(line) {
    const text = String(line || '').replace(/\s+/g, ' ');
    if (this.isFireTvContext(text)) return { version: '', version_code: '' };
    const versionPattern = String.raw`([0-9]+(?:\.[0-9]+){1,5}(?:(?:\+|-)(?:rc|beta|alpha)\d*)?(?:-20[0-9]{2}\.[0-9]{2}\.[0-9]{2})?)`;
    const patterns = [
      new RegExp('\\(\\s*Android\\s*TV\\s*\\)[^0-9]{0,220}(?:version\\s*:?\\s*)?' + versionPattern + '(?:\\s*\\((\\d+)\\)|\\s+build\\s+(\\d+))?', 'i'),
      new RegExp('Android\\s*TV[^0-9]{0,220}(?:version\\s*:?\\s*)?' + versionPattern + '(?:\\s*\\((\\d+)\\)|\\s+build\\s+(\\d+))?', 'i'),
      new RegExp('android-tv[^0-9]{0,220}(?:version\\s*:?\\s*)?' + versionPattern + '(?:[-\\s]+build[-\\s]+(\\d+)|\\s*\\((\\d+)\\))?', 'i'),
      new RegExp('Version\\s*:?\\s*' + versionPattern + '\\s*\\((\\d+)\\).*Android\\s*TV', 'i'),
      new RegExp('Latest\\s*:?\\s*' + versionPattern + '[^A-Za-z0-9]{0,60}(?:on|uploaded)?[^A-Za-z0-9]{0,120}Android\\s*TV', 'i'),
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return { version: this.cleanVersion(match[1]), version_code: match[2] || match[3] || '' };
    }
    return { version: '', version_code: '' };
  }

  versionCandidatesFromVariantText(text) {
    const source = String(text || '').replace(/\s+/g, ' ');
    const out = [];
    const seen = new Set();
    const versionPattern = String.raw`([0-9]+(?:\.[0-9]+){1,5}(?:(?:\+|-)(?:rc|beta|alpha)\d*)?(?:-20[0-9]{2}\.[0-9]{2}\.[0-9]{2})?)`;
    const patterns = [
      new RegExp('\\bVersion\\s*:?\\s*' + versionPattern + '\\s*(?:\\((\\d{2,})\\))?', 'gi'),
      new RegExp('\\bLatest\\s*:?\\s*' + versionPattern + '(?:\\s+on\\s+[A-Za-z]+\\s+\\d{1,2},\\s+20\\d{2})?', 'gi'),
      new RegExp('\\b' + versionPattern + '(?:\\s*\\((\\d{2,})\\))?\\s+for\\s+Android\\b', 'gi'),
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) {
        const version = this.cleanVersion(match[1]);
        const version_code = match[2] || '';
        if (!this.isUsableVersion(version)) continue;
        const key = `${version}:${version_code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ version, version_code });
      }
    }
    return out;
  }

  versionFromGenericLine(line) {
    const text = String(line || '').replace(/\s+/g, ' ').trim();
    if (/\.(?:png|jpg|jpeg|webp|gif|svg)\b/i.test(text)) return { version: '', version_code: '' };
    if (/\b(?:Image|File size|Downloads|Uploaded|Published|Updated|width|height|dpi|icon|premium)\b/i.test(text) && !/\bVersion\b/i.test(text)) {
      return { version: '', version_code: '' };
    }
    const explicit = text.match(/\bVersion\s*:?\s*([0-9]+(?:\.[0-9]+){1,5}(?:[-_](?:rc|beta|alpha)\d*)?)(?:\s*\((\d{2,})\)|\s+build\s+(\d{2,}))?/i);
    if (explicit) return { version: this.cleanVersion(explicit[1]), version_code: explicit[2] || explicit[3] || '' };
    return { version: '', version_code: '' };
  }

  isApkMirrorNoiseChunk(text) {
    return /\bApps related to\b|\bPopular In Last\b|\bFollow APK Mirror\b|Advertisement/i.test(String(text || ''));
  }

  lineBelongsToListing(line, listingSlug) {
    const source = String(line || '').toLowerCase();
    const slug = String(listingSlug || '').toLowerCase();
    if (!slug) return false;
    if (source.includes(`/${slug}/`) || source.includes(slug)) return true;
    if (/apkmirror\.com\/apk\//i.test(source)) return false;
    const tokens = this.importantTokens(slug.replace(/-/g, ' '));
    if (!tokens.length) return false;
    const hits = tokens.filter(t => source.includes(t)).length;
    return hits >= Math.min(2, tokens.length);
  }

  importantTokens(text) {
    const stop = new Set(['android','tv','apk','app','apps','play','player','stream','streaming','shows','show','series','on','demand','for','the','and','free','movies','anime','music','podcasts']);
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3 && !stop.has(t));
  }

  isConfirmedAndroidTvContext(text) {
    return ANDROID_TV_RE.test(String(text || ''));
  }

  isFireTvContext(text) {
    return FIRE_TV_RE.test(String(text || ''));
  }

  pickBestTvCandidate(candidates) {
    const usable = candidates
      .filter(c => c && c.usable && c.tv_confirmed && this.isUsableVersion(c.version) && !this.isFireTvContext(c.url))
      .sort((a, b) => {
        const versionCompare = this.compareVersions(b.version, a.version);
        if (versionCompare !== 0) return versionCompare;
        const buildCompare = Number(b.version_code || 0) - Number(a.version_code || 0);
        if (buildCompare !== 0) return buildCompare;
        const confidenceCompare = Number(b.confidence || 0) - Number(a.confidence || 0);
        if (Math.abs(confidenceCompare) > 0.001) return confidenceCompare;
        return 0;
      });
    return usable[0] || null;
  }

  async safeAdd(candidates, notes, label, fn) {
    try {
      const result = await fn();
      if (Array.isArray(result)) candidates.push(...result);
      else if (result) candidates.push(this.candidate({ source: label, ...result }));
    } catch (error) {
      const message = error?.name === 'AbortError' ? 'request timed out' : (error?.message || 'Unknown error');
      notes.push(`${label} failed: ${message}`);
      candidates.push(this.candidate({ source: label, error: message }));
    }
  }

  async fetchText(url, headers = {}, timeoutOverrideMs = null) {
    const controller = new AbortController();
    const timeout = Math.max(3000, Math.min(Number(timeoutOverrideMs || this.timeoutMs), this.timeoutMs));
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return text;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`request timed out after ${timeout}ms`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async withTimeout(promise, timeoutMs, message = 'operation timed out') {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  candidate(input) {
    const version = this.cleanVersion(input.version || '');
    const error = input.error || '';
    const usable = Boolean(input.usable ?? (this.isUsableVersion(version) && !error));
    return {
      source: input.source || '',
      version: version || null,
      version_code: input.version_code || '',
      usable,
      tv_confirmed: Boolean(input.tv_confirmed || false),
      confidence: Number(input.confidence || 0),
      updated: input.updated || '',
      url: input.url || '',
      tv_evidence: input.tv_evidence || '',
      note: input.note || error || '',
      error,
    };
  }

  failure(meta, candidates, notes, status, error, apkMirrorUrl, normalised = null) {
    return {
      ok: false,
      status,
      ...meta,
      version: null,
      version_code: '',
      google_play_version: candidates.find(c => c.source === 'google-play-scraper')?.version || null,
      source: '',
      source_url: '',
      apk_mirror_tv_url: apkMirrorUrl || '',
      confidence: 0,
      error,
      warning: this.summary(candidates, notes),
      candidates,
      source_debug: normalised ? this.sourceDebug(candidates, normalised) : undefined,
    };
  }

  cleanVersion(value) {
    let version = this.decodeHtml(String(value || '').trim()).replace(/[\s,;]+$/g, '').replace(/_/g, '-');
    if (/^(vary|varies with device|depends on device|unknown|n\/a)$/i.test(version)) {
      return /^vary$/i.test(version) ? 'VARY' : '';
    }
    version = version.replace(/^version\s*:?\s*/i, '').replace(/^v(?=\d)/i, '').trim();
    if (/^(vary|varies with device|depends on device|unknown|n\/a)$/i.test(version)) {
      return /^vary$/i.test(version) ? 'VARY' : '';
    }
    return version;
  }

  isUsableVersion(value) {
    const version = this.cleanVersion(value);
    if (!/^[0-9]+(?:\.[0-9]+){1,5}(?:(?:\+|-)(?:rc|beta|alpha)\d*)?(?:-20[0-9]{2}\.[0-9]{2}\.[0-9]{2})?$/i.test(version)) return false;
    const main = version.split(/[+_-]/, 1)[0];
    const parts = main.split('.').map(v => Number.parseInt(v, 10));
    if (parts.length < 2) return false;
    // Reject standalone dates accidentally parsed as versions, e.g. 2025.03.14 or 2026.04.21.
    if (parts.length >= 3 && parts[0] >= 2000 && parts[0] <= 2099 && parts[1] >= 1 && parts[1] <= 12 && parts[2] >= 1 && parts[2] <= 31) return false;
    if (parts.length === 2 && parts[1] >= 2000 && parts[1] <= 2099) return false;
    if (parts.length === 2 && parts[0] >= 32 && parts[1] >= 32) return false;
    return true;
  }

  compareVersions(a, b) {
    const pa = this.versionParts(a);
    const pb = this.versionParts(b);
    const len = Math.max(pa.numbers.length, pb.numbers.length);
    for (let i = 0; i < len; i += 1) {
      const av = pa.numbers[i] || 0;
      const bv = pb.numbers[i] || 0;
      if (av !== bv) return av - bv;
    }
    return this.suffixWeight(pa.suffix) - this.suffixWeight(pb.suffix);
  }

  versionParts(version) {
    const raw = String(version || '').toLowerCase();
    const main = raw.split(/[+_-]/, 1)[0];
    const suffixMatch = raw.match(/(?:\+|-|_)((?:rc|beta|alpha)\d*)/i);
    return { numbers: main.split('.').map(v => Number.parseInt(v, 10)).filter(Number.isFinite), suffix: suffixMatch?.[1] || '' };
  }

  suffixWeight(suffix) {
    if (!suffix) return 100;
    if (suffix.startsWith('rc')) return 80;
    if (suffix.startsWith('beta')) return 60;
    if (suffix.startsWith('alpha')) return 40;
    return 50;
  }

  hyphenVersionToDotted(raw) {
    const tokens = String(raw || '').split('-').filter(Boolean);
    const nums = [];
    let suffix = '';
    for (const token of tokens) {
      if (/^\d+$/.test(token) && suffix === '') nums.push(String(Number(token)));
      else suffix = [suffix, token].filter(Boolean).join('-');
    }
    return nums.length ? nums.join('.') + (suffix ? `-${suffix}` : '') : '';
  }

  normaliseUpdated(value) {
    if (!value) return '';
    if (typeof value === 'number') {
      const ms = value < 10000000000 ? value * 1000 : value;
      return new Date(ms).toISOString().slice(0, 10);
    }
    return String(value);
  }

  updatedFromText(text) {
    const match = String(text || '').match(/(?:Updated|Uploaded|Release Date|Date)[:\s]+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
    return match ? match[1] : '';
  }

  contextAround(text, needle, radius = 400) {
    const source = String(text || '');
    const index = source.indexOf(needle);
    if (index < 0) return '';
    return source.slice(Math.max(0, index - radius), Math.min(source.length, index + String(needle).length + radius));
  }

  toPlainText(text) {
    return this.decodeHtml(String(text || '')
      .replace(/<script[\s\S]*?<\/script>/gi, '\n')
      .replace(/<style[\s\S]*?<\/style>/gi, '\n')
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(p|div|li|a|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim());
  }

  decodeHtml(value) {
    return String(value || '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ');
  }

  uniqueBy(items, fn) {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const key = fn(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  summary(candidates, notes = []) {
    const bits = [...notes];
    for (const c of candidates || []) {
      bits.push(`${c.source || 'source'}: ${c.version || 'none'}${c.tv_confirmed ? ' [TV]' : ''}${c.note ? ` (${c.note})` : c.error ? ` (${c.error})` : ''}`);
    }
    return bits.filter(Boolean).join(' | ');
  }

  sourceDebug(candidates, normalised) {
    const versionsSeen = (candidates || [])
      .filter(c => (c.source === 'apkmirror-source-url' || c.source === 'apkpure-tv-url') && c.version)
      .map(c => ({ version: c.version, url: c.url, tv: c.tv_confirmed, note: c.note }))
      .slice(0, 20);
    return {
      source_kind: normalised.kind,
      source_url: normalised.source_url,
      source_has_tv_hint: normalised.source_has_tv_hint,
      top_versions_seen: versionsSeen,
      rejected_mobile_fire_tv_policy: 'Only Android TV rows/links are eligible. Fire-TV and generic/mobile versions are rejected.',
    };
  }

  playUrl(packageName) {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=${encodeURIComponent(this.language)}&gl=${encodeURIComponent(this.country)}`;
  }
}

module.exports = { AndroidTvVersionProvider, PROVIDER_BUILD };
