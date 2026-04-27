// FINAL TV SAFE RESOLVER BUILD 1.1.1
// Purpose: return a version only when it is confirmed as an Android TV release.
// Google Play is used for metadata. If Google Play returns VARY, that is diagnostic only.
// Generic/mobile fallbacks are collected for debugging, but they are never selected as final.

const PROVIDER_BUILD = 'google-play-provider-tv-safe-1.1.1';

const PLAY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const APKMIRROR_HOST = 'https://www.apkmirror.com';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'plus', 'app', 'apps', 'tv', 'android', 'stream', 'streaming',
  'watch', 'player', 'play', 'on', 'demand', 'movies', 'movie', 'shows', 'show', 'series', 'free',
  'live', 'video', 'music', 'podcasts', 'news', 'limited', 'ltd', 'inc', 'llc', 'media', 'group',
]);

class AndroidTvVersionProvider {
  constructor({ language = 'en', country = 'gb', timeoutMs = 14000 } = {}) {
    this.language = String(language || 'en');
    this.country = String(country || 'gb');
    this.timeoutMs = Math.max(5000, Math.min(Number(timeoutMs || 14000), 20000));
    this.gplayModule = null;
  }

  async loadScraper() {
    if (this.gplayModule) return this.gplayModule;
    const imported = await import('google-play-scraper');
    this.gplayModule = imported.default || imported;
    return this.gplayModule;
  }

  async lookup(packageName) {
    const startedAt = Date.now();
    const candidates = [];
    const notes = [];
    const playMeta = {
      package_name: packageName,
      title: '',
      developer: '',
      updated: '',
      url: this.playUrl(packageName),
    };

    await this.safeAddCandidates(candidates, notes, 'google-play-scraper', async () => {
      const gplay = await this.loadScraper();
      const app = await gplay.app({ appId: packageName, lang: this.language, country: this.country });
      playMeta.title = String(app?.title || '');
      playMeta.developer = String(app?.developer || app?.developerName || '');
      playMeta.updated = this.normaliseUpdated(app?.updated || app?.released || '');
      playMeta.url = String(app?.url || this.playUrl(packageName));

      const playVersion = this.cleanVersion(app?.version || '');
      return [this.makeCandidate({
        source: 'google-play-scraper',
        version: playVersion,
        version_code: '',
        updated: playMeta.updated,
        url: playMeta.url,
        confidence: this.isUsableVersion(playVersion) ? 0.5 : 0.05,
        platform: 'google-play-public',
        tv_confirmed: false,
        note: this.isUsableVersion(playVersion)
          ? 'Google Play exposed a concrete public version. Not selected unless Android TV is confirmed elsewhere.'
          : `Google Play version was "${playVersion || 'blank'}". This is metadata only; Android TV sources were checked.`,
      })];
    });

    // Direct Play HTML is useful as a diagnostic only. It is not accepted as Android TV proof.
    if (this.remainingMs(startedAt) > 5000) {
      await this.safeAddCandidates(candidates, notes, 'google-play-html', () => this.lookupGooglePlayHtml(packageName));
    }

    // Main source: APKMirror Android TV listings discovered programmatically.
    if (this.remainingMs(startedAt) > 6000) {
      await this.safeAddCandidates(candidates, notes, 'apkmirror-tv', () => this.lookupApkMirrorTv(packageName, playMeta.title, playMeta.developer, startedAt));
    }

    // Diagnostic-only generic sources. They help explain conflicts, but are never selected as final.
    if (this.remainingMs(startedAt) > 5000) {
      await this.safeAddCandidates(candidates, notes, 'aptoide-getmeta', () => this.lookupAptoideGetMeta(packageName));
    }
    if (this.remainingMs(startedAt) > 4500) {
      await this.safeAddCandidates(candidates, notes, 'aptoide-search', () => this.lookupAptoideSearch(packageName));
    }
    if (this.remainingMs(startedAt) > 4500) {
      await this.safeAddCandidates(candidates, notes, 'aptoide-html', () => this.lookupAptoideHtml(packageName, playMeta.title));
    }

    const winner = this.pickBestTvCandidate(candidates);
    if (winner) {
      return this.successResult(playMeta, winner, candidates, notes);
    }

    return {
      ok: false,
      ...playMeta,
      version: null,
      version_code: '',
      google_play_version: candidates.find(c => c.source === 'google-play-scraper')?.version || null,
      source: '',
      source_url: '',
      confidence: 0,
      error: 'No confirmed Android TV version found. Generic/mobile versions were not selected.',
      warning: this.buildSummary(candidates, notes),
      candidates,
    };
  }

  successResult(playMeta, winner, candidates, notes) {
    return {
      ok: true,
      ...playMeta,
      version: winner.version,
      version_code: winner.version_code || '',
      google_play_version: candidates.find(c => c.source === 'google-play-scraper')?.version || null,
      source: winner.source,
      source_url: winner.url || '',
      confidence: winner.confidence,
      selected_reason: winner.selected_reason || '',
      tv_evidence: winner.tv_evidence || '',
      rank_score: winner.rank_score || null,
      warning: this.buildSummary(candidates.filter(c => !c.tv_confirmed || c.version !== winner.version || c.source !== winner.source), notes),
      candidates,
    };
  }

  async lookupGooglePlayHtml(packageName) {
    const url = this.playUrl(packageName);
    const html = await this.fetchText(url, {
      'User-Agent': PLAY_UA,
      'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });
    const version = this.cleanVersion(this.extractFirst(html, [
      /"softwareVersion"\s*:\s*"([^"]+)"/i,
      /Current\s+Version[\s\S]{0,400}?>([^<]{1,60})</i,
      /Version[\s\S]{0,200}?>([0-9][0-9A-Za-z._-]{0,40})</i,
    ]));
    return [this.makeCandidate({
      source: 'google-play-html',
      version,
      updated: this.extractFirst(html, [/Updated on[\s\S]{0,300}?>([^<]{4,40})</i]),
      url,
      confidence: this.isUsableVersion(version) ? 0.35 : 0.04,
      platform: 'google-play-public',
      tv_confirmed: false,
      note: this.isUsableVersion(version) ? 'Direct Google Play HTML exposed a version, but it is not Android TV-confirmed.' : 'Direct Google Play HTML did not expose a usable version.',
    })];
  }

  async lookupApkMirrorTv(packageName, title, developer, startedAt) {
    const out = [];
    const discovered = await this.discoverApkMirrorTvListings(packageName, title, developer, startedAt);
    out.push(...discovered.diagnostics);

    if (!discovered.urls.length) {
      out.push(this.makeCandidate({
        source: 'apkmirror-tv-discovery',
        error: 'No APKMirror Android TV listing URL discovered. No generic/mobile version will be selected.',
      }));
      return out;
    }

    for (const item of discovered.urls.slice(0, 3)) {
      if (this.remainingMs(startedAt) < 4500) {
        out.push(this.makeCandidate({ source: 'apkmirror-tv', url: item.url, error: 'Skipped listing fetch because resolver time budget was nearly exhausted.' }));
        break;
      }

      const readerUrl = `https://r.jina.ai/${item.url}`;
      try {
        const text = await this.fetchText(readerUrl, {
          'User-Agent': PLAY_UA,
          'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
          Accept: 'text/plain,*/*;q=0.8',
        }, Math.min(this.timeoutMs, Math.max(3500, this.remainingMs(startedAt) - 1000)));

        const parsed = this.extractApkMirrorTvCandidates(text, item.url, item.discovery_score, title, developer);
        if (parsed.length) out.push(...parsed);
        else out.push(this.makeCandidate({
          source: 'apkmirror-tv-listing',
          url: item.url,
          platform: 'android-tv-listing',
          error: 'APKMirror Android TV listing was fetched but no release version was parsed.',
        }));
      } catch (error) {
        out.push(this.makeCandidate({ source: 'apkmirror-tv-listing', url: item.url, error: error.message || 'APKMirror reader fetch failed' }));
      }
    }

    return out;
  }

  async discoverApkMirrorTvListings(packageName, title, developer, startedAt) {
    const diagnostics = [];
    const found = new Map();
    const displayTitle = String(title || packageName || '').trim();
    const firstTitlePart = String(displayTitle).split(/[:–—-]/)[0].trim();
    const displayDeveloper = String(developer || '').trim();

    const queries = Array.from(new Set([
      `"${displayTitle}" "Android TV" "APKMirror"`,
      `"${firstTitlePart}" "Android TV" "APKMirror"`,
      `${packageName} "Android TV" "APKMirror"`,
      displayDeveloper ? `"${displayDeveloper}" "${firstTitlePart}" "Android TV" "APKMirror"` : '',
    ].filter(Boolean))).slice(0, 4);

    for (const query of queries) {
      if (this.remainingMs(startedAt) < 5000) {
        diagnostics.push(this.makeCandidate({ source: 'apkmirror-tv-discovery', error: 'Stopped discovery early due to resolver time budget.' }));
        break;
      }

      const searchUrl = `https://s.jina.ai/${encodeURIComponent(query)}`;
      try {
        const text = await this.fetchText(searchUrl, {
          'User-Agent': PLAY_UA,
          'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
          Accept: 'text/plain,*/*;q=0.8',
        }, Math.min(this.timeoutMs, Math.max(3500, this.remainingMs(startedAt) - 1000)));

        // Some search pages already contain a valid APKMirror Android TV release line. Capture those too.
        const directCandidates = this.extractApkMirrorTvCandidates(text, searchUrl, 0.90, title, developer);
        for (const candidate of directCandidates) diagnostics.push({ ...candidate, source: 'apkmirror-tv-search-result' });

        const urls = this.extractApkMirrorListingUrls(text, packageName, displayTitle, displayDeveloper);
        for (const item of urls) {
          const existing = found.get(item.url);
          if (!existing || item.discovery_score > existing.discovery_score) found.set(item.url, item);
        }
      } catch (error) {
        diagnostics.push(this.makeCandidate({
          source: 'apkmirror-tv-discovery',
          url: searchUrl,
          error: error.message || 'APKMirror discovery search failed',
        }));
      }
    }

    const urls = Array.from(found.values())
      .sort((a, b) => b.discovery_score - a.discovery_score)
      .slice(0, 3);

    diagnostics.push(this.makeCandidate({
      source: 'apkmirror-tv-discovery',
      version: '',
      usable: false,
      url: urls.map(u => u.url).join(' | '),
      note: urls.length ? `Discovered ${urls.length} Android TV APKMirror listing URL(s).` : 'No Android TV APKMirror listing URL discovered.',
    }));

    return { urls, diagnostics };
  }

  extractApkMirrorListingUrls(text, packageName, title, developer) {
    const decoded = this.decode(text);
    const urls = new Map();

    const add = (rawUrl, index = 0) => {
      if (!rawUrl) return;
      let url = String(rawUrl).replace(/[)>\]"'.,]+$/g, '').trim();
      if (url.startsWith('/apk/')) url = `${APKMIRROR_HOST}${url}`;
      if (!url.startsWith(`${APKMIRROR_HOST}/apk/`)) return;
      url = this.normaliseApkMirrorListingUrl(url);
      if (!url) return;

      const context = this.contextWindow(decoded, index, 520, 700);
      const score = this.scoreApkMirrorTvListing(url, context, packageName, title, developer);
      if (score < 18) return;

      const existing = urls.get(url);
      const item = { url, discovery_score: score, discovery_context: context.slice(0, 600) };
      if (!existing || score > existing.discovery_score) urls.set(url, item);
    };

    const absolute = /https:\/\/www\.apkmirror\.com\/apk\/[A-Za-z0-9/_%.,+()\-]+\/?/gi;
    let match;
    while ((match = absolute.exec(decoded)) !== null) add(match[0], match.index);

    const markdownAbsolute = /\((https:\/\/www\.apkmirror\.com\/apk\/[A-Za-z0-9/_%.,+()\-]+\/?)\)/gi;
    while ((match = markdownAbsolute.exec(decoded)) !== null) add(match[1], match.index);

    const relative = /\((\/apk\/[A-Za-z0-9/_%.,+()\-]+\/?)\)/gi;
    while ((match = relative.exec(decoded)) !== null) add(match[1], match.index);

    return Array.from(urls.values());
  }

  normaliseApkMirrorListingUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname !== 'www.apkmirror.com') return '';
      const parts = u.pathname.split('/').filter(Boolean);
      const apkIndex = parts.indexOf('apk');
      if (apkIndex < 0 || parts.length < apkIndex + 3) return '';
      // Listing root: /apk/<developer>/<app-slug>/ . Release/download pages have extra path segments.
      const rootParts = parts.slice(0, apkIndex + 3);
      return `${APKMIRROR_HOST}/${rootParts.join('/')}/`;
    } catch (error) {
      return '';
    }
  }

  scoreApkMirrorTvListing(url, context, packageName, title, developer) {
    const haystack = `${url} ${context}`.toLowerCase();
    const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch (error) { return ''; } })();
    let score = 0;

    const tvSignal = /android[-_ ]?tv|\(\s*android\s*tv\s*\)|for\s+android\s+tv|requires\s+android\s+tv/i.test(haystack);
    if (!tvSignal) return 0;
    score += 20;
    if (/android-tv/i.test(path)) score += 18;
    if (/\(\s*android\s*tv\s*\)|for\s+android\s+tv|requires\s+android\s+tv/i.test(context)) score += 12;
    if (packageName && haystack.includes(String(packageName).toLowerCase())) score += 5;

    const titleTokens = this.importantTokens(title);
    const developerTokens = this.importantTokens(developer);
    const titleOverlap = titleTokens.filter(t => haystack.includes(t)).length;
    const developerOverlap = developerTokens.filter(t => haystack.includes(t)).length;
    score += Math.min(16, titleOverlap * 4);
    score += Math.min(12, developerOverlap * 4);

    // Prevent random Android TV APKMirror listings from being accepted just because they are TV apps.
    if (titleTokens.length >= 2 && titleOverlap === 0) return 0;
    if (titleTokens.length && developerTokens.length && titleOverlap === 0 && developerOverlap === 0) return 0;

    return score;
  }

  extractApkMirrorTvCandidates(text, sourceUrl, discoveryScore, title, developer) {
    const decoded = this.decode(text);
    const out = [];
    const seen = new Set();
    const sourceUrlString = String(sourceUrl || '');
    const sourceLooksTv = /android-tv/i.test(sourceUrlString) || /"Android TV"|\(Android TV\)|Requires Android TV/i.test(decoded);

    const addCandidate = (index, whole, version, versionCode = '') => {
      const cleanVersion = this.cleanVersion(version);
      if (!this.isUsableVersion(cleanVersion)) return;
      if (/^\d+(?:\.\d+)?$/.test(cleanVersion) && /android\s+\d/i.test(whole) && !/\(\s*Android\s*TV\s*\)|Android\s+TV/i.test(whole)) return;

      const context = this.contextWindow(decoded, index, 700, 900);
      const heading = this.previousHeading(decoded, index);
      const combined = `${whole} ${heading} ${context} ${sourceUrlString}`;
      const tvEvidence = this.tvEvidence(combined);
      if (!tvEvidence) return;

      // The result must resemble the requested app, not just any Android TV app.
      if (!this.matchesRequestedApp(combined, title, developer)) return;

      const key = `${cleanVersion}:${versionCode || ''}:${sourceUrlString}`;
      if (seen.has(key)) return;
      seen.add(key);

      out.push(this.makeCandidate({
        source: sourceUrlString.startsWith('https://s.jina.ai/') ? 'apkmirror-tv-search-result' : 'apkmirror-tv-listing',
        version: cleanVersion,
        version_code: versionCode || this.extractFirst(combined, [/\(([0-9]{3,})\)\s+for\s+Android/i, /build\s+([0-9]{2,})/i]),
        updated: this.extractDateNear(decoded, index),
        url: sourceUrlString,
        confidence: Math.min(0.995, 0.91 + Math.min(0.07, Number(discoveryScore || 0) / 1000)),
        platform: 'android-tv',
        tv_confirmed: true,
        tv_evidence: tvEvidence,
        note: `Confirmed Android TV APKMirror candidate. Evidence: ${tvEvidence}`,
      }));
    };

    const lines = decoded.split(/\r?\n/);
    let offset = 0;
    for (const line of lines) {
      const lineStart = offset;
      offset += line.length + 1;
      const lineText = String(line || '');
      if (!/android[-_ ]?tv|\(\s*Android\s*TV\s*\)|Requires\s+Android\s+TV/i.test(lineText + ' ' + sourceUrlString)) continue;
      const rx = /\b([0-9]+(?:[._-][0-9]+){1,7})(?:\s+build\s+([0-9]{2,}))?\b/gi;
      let m;
      while ((m = rx.exec(lineText)) !== null) {
        addCandidate(lineStart + m.index, lineText, m[1], m[2] || '');
      }
    }

    const patterns = [
      /([^\n]{0,300}?\(\s*Android\s*TV\s*\)[^\n]{0,300}?\b([0-9]+(?:[._-][0-9]+){1,7})(?:\s+build\s+([0-9]{2,}))?[^\n]*)/gi,
      /(Download\s+[^\n]{0,300}?Android\s+TV[^\n]{0,300}?\b([0-9]+(?:[._-][0-9]+){1,7})(?:\s+build\s+([0-9]{2,}))?[^\n]*)/gi,
      /(Version\s*:\s*([0-9]+(?:[._-][0-9]+){1,7})(?:\s+build\s+([0-9]{2,}))?[^\n]{0,140})/gi,
    ];

    for (const regex of patterns) {
      let match;
      while ((match = regex.exec(decoded)) !== null) {
        const whole = String(match[1] || match[0] || '');
        if (!sourceLooksTv && !/Android\s+TV|android-tv/i.test(whole)) continue;
        addCandidate(match.index, whole, match[2] || '', match[3] || '');
      }
    }

    return out;
  }

  pickBestTvCandidate(candidates) {
    const tvCandidates = candidates
      .filter(c => c.usable && c.tv_confirmed && c.platform === 'android-tv' && this.isUsableVersion(c.version))
      .map(c => ({ ...c, rank_score: this.rankTvCandidate(c, candidates) }))
      .sort((a, b) => {
        const versionDiff = this.compareVersions(b.version, a.version);
        if (versionDiff !== 0) return versionDiff;
        const rankDiff = Number(b.rank_score || 0) - Number(a.rank_score || 0);
        if (Math.abs(rankDiff) > 0.001) return rankDiff;
        return Number(b.confidence || 0) - Number(a.confidence || 0);
      });

    const winner = tvCandidates[0];
    if (!winner) return null;
    return {
      ...winner,
      selected_reason: `Selected ${winner.version} because it is the highest confirmed Android TV candidate. Generic/mobile fallbacks are diagnostic only.`,
    };
  }

  rankTvCandidate(candidate, allCandidates = []) {
    let score = 100;
    if (candidate.source === 'apkmirror-tv-listing') score += 25;
    if (candidate.source === 'apkmirror-tv-search-result') score += 18;
    if (/android-tv/i.test(candidate.url || '')) score += 8;
    score += Number(candidate.confidence || 0) * 10;
    const sameVersionCount = allCandidates.filter(c => c.version === candidate.version).length;
    score += Math.min(8, sameVersionCount * 2);
    return Number(score.toFixed(3));
  }

  async lookupAptoideGetMeta(packageName) {
    const urls = [
      `https://ws2.aptoide.com/api/7/app/getMeta/package_name=${encodeURIComponent(packageName)}`,
      `https://ws75.aptoide.com/api/7/app/getMeta/package_name=${encodeURIComponent(packageName)}`,
    ];
    const out = [];
    for (const url of urls) {
      try {
        const json = await this.fetchJson(url);
        const data = json?.data || {};
        const file = data?.file || {};
        const foundPackage = String(data?.package || file?.package || '');
        const version = this.cleanVersion(file?.vername || data?.vername || data?.version || '');
        out.push(this.makeCandidate({
          source: 'aptoide-getmeta',
          version,
          version_code: file?.vercode || data?.vercode || '',
          updated: data?.updated || data?.modified || file?.added || '',
          url,
          confidence: foundPackage === packageName && this.isUsableVersion(version) ? 0.35 : 0.05,
          platform: 'generic-public-fallback',
          tv_confirmed: false,
          note: foundPackage && foundPackage !== packageName ? `Package mismatch: ${foundPackage}` : 'Generic fallback only. Not Android TV-confirmed and will not be selected.',
        }));
      } catch (error) {
        out.push(this.makeCandidate({ source: 'aptoide-getmeta', url, error: error.message || 'Aptoide getMeta failed' }));
      }
    }
    return out;
  }

  async lookupAptoideSearch(packageName) {
    const urls = [
      `https://ws75.aptoide.com/api/7/apps/search/query=${encodeURIComponent(packageName)}/limit=10`,
      `https://ws2.aptoide.com/api/7/apps/search/query=${encodeURIComponent(packageName)}/limit=10`,
    ];
    const out = [];
    for (const url of urls) {
      try {
        const json = await this.fetchJson(url);
        const list = json?.datalist?.list || [];
        let matched = false;
        for (const item of list) {
          const foundPackage = String(item?.package || '');
          if (foundPackage !== packageName) continue;
          matched = true;
          const file = item?.file || {};
          const version = this.cleanVersion(file?.vername || item?.vername || item?.version || '');
          out.push(this.makeCandidate({
            source: 'aptoide-search',
            version,
            version_code: file?.vercode || item?.vercode || '',
            updated: item?.updated || item?.modified || file?.added || '',
            url,
            confidence: this.isUsableVersion(version) ? 0.30 : 0,
            platform: 'generic-public-fallback',
            tv_confirmed: false,
            note: 'Generic fallback only. Not Android TV-confirmed and will not be selected.',
          }));
        }
        if (!matched) out.push(this.makeCandidate({ source: 'aptoide-search', url, error: 'No exact package match in Aptoide search results.' }));
      } catch (error) {
        out.push(this.makeCandidate({ source: 'aptoide-search', url, error: error.message || 'Aptoide search failed' }));
      }
    }
    return out;
  }

  async lookupAptoideHtml(packageName, title) {
    const urls = this.aptoideHtmlUrls(packageName, title);
    const out = [];
    for (const url of urls) {
      try {
        const html = await this.fetchText(url, {
          'User-Agent': PLAY_UA,
          'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: 'https://www.google.com/',
        });
        const text = this.decode(html);
        const version = this.cleanVersion(this.extractFirst(text, [
          /"version_name"\s*:\s*"([0-9][0-9A-Za-z._-]{0,40})"/i,
          /Version\s+([0-9][0-9A-Za-z._-]{0,40})/i,
          /Download[^<]{0,160}?\s([0-9]+(?:[._-][0-9A-Za-z]+){1,6})\s+APK/i,
        ]));
        out.push(this.makeCandidate({
          source: 'aptoide-html',
          version,
          version_code: '',
          updated: this.extractFirst(text, [/\((\d{1,2}-\d{1,2}-20\d{2})\)/i]),
          url,
          confidence: this.isUsableVersion(version) ? 0.25 : 0,
          platform: 'generic-public-fallback',
          tv_confirmed: false,
          note: this.isUsableVersion(version) ? 'Generic fallback only. Not Android TV-confirmed and will not be selected.' : 'Aptoide page returned but no usable version was parsed.',
        }));
      } catch (error) {
        out.push(this.makeCandidate({ source: 'aptoide-html', url, error: error.message || 'Aptoide HTML fetch failed' }));
      }
    }
    return out;
  }

  async safeAddCandidates(candidates, notes, label, fn) {
    try {
      const result = await fn();
      if (Array.isArray(result)) candidates.push(...result);
      else if (Array.isArray(result?.candidates)) candidates.push(...result.candidates);
      else if (result) candidates.push(this.makeCandidate({ source: label, ...result }));
    } catch (error) {
      const message = error.message || 'Unknown error';
      notes.push(`${label} failed: ${message}`);
      candidates.push(this.makeCandidate({ source: label, error: message }));
    }
  }

  makeCandidate({ source, version = '', version_code = '', updated = '', url = '', confidence = 0, note = '', error = '', platform = '', tv_confirmed = false, tv_evidence = '' }) {
    const clean = this.cleanVersion(version);
    const usable = this.isUsableVersion(clean);
    return {
      source,
      version: clean || null,
      version_code: version_code || null,
      usable,
      confidence: usable ? Number(confidence || 0.5) : 0,
      updated: updated || null,
      url: url || null,
      platform: platform || null,
      tv_confirmed: Boolean(tv_confirmed && usable),
      tv_evidence: tv_evidence || null,
      note: error || note || '',
    };
  }

  buildSummary(candidates, notes) {
    const candidateNotes = candidates.slice(0, 28).map(c => {
      const tv = c.tv_confirmed ? ', tv confirmed' : '';
      return `${c.source}: ${c.version || 'none'}${tv}${c.note ? ` (${c.note})` : ''}`;
    });
    return [...notes, ...candidateNotes].filter(Boolean).join(' | ');
  }

  tvEvidence(value) {
    const s = String(value || '');
    if (/Requires\s+Android\s+TV/i.test(s)) return 'Requires Android TV';
    if (/\(\s*Android\s*TV\s*\)/i.test(s)) return '(Android TV) in release title';
    if (/for\s+Android\s+TV/i.test(s)) return 'for Android TV';
    if (/android-tv/i.test(s)) return 'android-tv in APKMirror URL/context';
    if (/Android\s+TV/i.test(s)) return 'Android TV in context';
    return '';
  }

  matchesRequestedApp(value, title, developer) {
    const haystack = String(value || '').toLowerCase();
    const titleTokens = this.importantTokens(title);
    const developerTokens = this.importantTokens(developer);
    const titleOverlap = titleTokens.filter(t => haystack.includes(t)).length;
    const developerOverlap = developerTokens.filter(t => haystack.includes(t)).length;
    if (titleTokens.length >= 2) return titleOverlap >= 1 || developerOverlap >= 1;
    if (titleTokens.length === 1) return titleOverlap >= 1 || developerOverlap >= 1;
    return true;
  }

  importantTokens(value) {
    return Array.from(new Set(String(value || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/\+/g, ' plus ')
      .replace(/[^a-z0-9]+/g, ' ')
      .split(/\s+/)
      .map(t => t.trim())
      .filter(t => t.length >= 3 && !STOP_WORDS.has(t))));
  }

  previousHeading(text, index) {
    const prefix = String(text || '').slice(Math.max(0, Number(index || 0) - 2500), Number(index || 0));
    const lines = prefix.split(/\r?\n/).reverse();
    return lines.find(line => /^\s*#{1,6}\s+/.test(line) || /\(\s*Android\s*TV\s*\)/i.test(line)) || '';
  }

  contextWindow(text, index, before = 360, after = 540) {
    const s = String(text || '');
    const i = Number(index || 0);
    return s.slice(Math.max(0, i - before), Math.min(s.length, i + after));
  }

  extractDateNear(text, index) {
    const windowText = this.contextWindow(text, index, 240, 420);
    return this.extractFirst(windowText, [/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+20\d{2}/i, /20\d{2}-\d{2}-\d{2}/i]);
  }

  aptoideHtmlUrls(packageName, title) {
    const names = new Set();
    const titleSlug = this.slugify(title);
    const firstPartSlug = this.slugify(String(title || '').split(/[:–—-]/)[0]);
    [titleSlug, firstPartSlug].forEach(slug => { if (slug) names.add(slug); });
    const urls = [];
    for (const name of names) {
      urls.push(`https://${name}.en.aptoide.com/app`);
      urls.push(`https://${name}.en.aptoide.com/app/${encodeURIComponent(packageName)}`);
    }
    return Array.from(new Set(urls)).slice(0, 4);
  }

  playUrl(packageName) {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=${encodeURIComponent(this.language)}&gl=${encodeURIComponent(this.country.toUpperCase())}`;
  }

  remainingMs(startedAt) {
    const totalBudget = Math.max(12000, Math.min(this.timeoutMs * 3, 42000));
    return totalBudget - (Date.now() - Number(startedAt || Date.now()));
  }

  async fetchText(url, headers = {}, timeoutOverride = null) {
    const controller = new AbortController();
    const ms = Math.max(2500, Math.min(Number(timeoutOverride || this.timeoutMs), 20000));
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchJson(url, headers = {}) {
    const text = await this.fetchText(url, { 'User-Agent': PLAY_UA, Accept: 'application/json,text/plain,*/*', ...headers });
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`JSON parse failed: ${error.message}`);
    }
  }

  extractFirst(text, patterns) {
    const haystack = String(text || '');
    for (const pattern of patterns) {
      const match = pattern.exec(haystack);
      if (!match) continue;
      if (match[1]) return this.decode(String(match[1]).trim());
      if (match[0]) return this.decode(String(match[0]).trim());
    }
    return '';
  }

  normaliseUpdated(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    const asString = String(value || '').trim();
    if (/^\d{12,}$/.test(asString)) {
      const d = new Date(Number(asString));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    return asString;
  }

  cleanVersion(value) {
    const version = this.decode(String(value || '').trim());
    return version.replace(/^v(?=\d)/i, '').replace(/\s+build\s+\d+$/i, '').trim();
  }

  isUsableVersion(version) {
    const v = String(version || '').trim();
    if (!v) return false;
    if (/^(vary|varies|varies with device|n\/a|unknown|null|undefined)$/i.test(v)) return false;
    return /^\d+(?:[._-]\d+){1,7}(?:[A-Za-z0-9._-]*)?$/.test(v);
  }

  compareVersions(a, b) {
    const aa = String(a || '').split(/[._-]/).map(part => parseInt(part, 10)).filter(n => Number.isFinite(n));
    const bb = String(b || '').split(/[._-]/).map(part => parseInt(part, 10)).filter(n => Number.isFinite(n));
    const max = Math.max(aa.length, bb.length);
    for (let i = 0; i < max; i += 1) {
      const diff = (aa[i] || 0) - (bb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  slugify(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/\+/g, ' plus ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-{2,}/g, '-');
  }

  decode(value) {
    return String(value || '')
      .replace(/\\u003d/g, '=')
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ');
  }
}

module.exports = { AndroidTvVersionProvider, PROVIDER_BUILD };
