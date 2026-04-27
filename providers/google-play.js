// PROGRAMMATIC ANDROID TV APKMIRROR BUILD 1.0.9
// No package-specific APKMirror overrides are used in this build.
// Flow:
// 1. Use Google Play for metadata.
// 2. If Google Play exposes a real version, keep it as a candidate, but do not stop there.
// 3. Programmatically discover APKMirror Android TV listing pages from search output.
// 4. Only accept APKMirror versions where the listing/candidate has Android TV signals.
// 5. Rank Android TV APKMirror candidates above generic/mobile fallbacks.

const PROVIDER_BUILD = 'google-play-provider-programmatic-apkmirror-tv-1.0.9';

const PLAY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'plus', 'app', 'apps', 'tv', 'android', 'stream', 'streaming',
  'watch', 'player', 'play', 'on', 'demand', 'movies', 'shows', 'series', 'free', 'live', 'video',
]);

class AndroidTvVersionProvider {
  constructor({ language = 'en', country = 'gb', timeoutMs = 30000 } = {}) {
    this.language = String(language || 'en');
    this.country = String(country || 'gb');
    this.timeoutMs = Number(timeoutMs || 30000);
    this.gplayModule = null;
  }

  async loadScraper() {
    if (this.gplayModule) return this.gplayModule;
    const imported = await import('google-play-scraper');
    this.gplayModule = imported.default || imported;
    return this.gplayModule;
  }

  async lookup(packageName) {
    const candidates = [];
    const notes = [];
    const playMeta = {
      package_name: packageName,
      title: '',
      developer: '',
      updated: '',
      url: this.playUrl(packageName),
    };

    // Google Play is still the best source for metadata. For Android TV apps it often returns VARY.
    try {
      const gplay = await this.loadScraper();
      const app = await gplay.app({ appId: packageName, lang: this.language, country: this.country });
      playMeta.title = String(app?.title || '');
      playMeta.developer = String(app?.developer || app?.developerName || '');
      playMeta.updated = this.normaliseUpdated(app?.updated || app?.released || '');
      playMeta.url = String(app?.url || this.playUrl(packageName));

      const playVersion = this.cleanVersion(app?.version || '');
      candidates.push(this.makeCandidate({
        source: 'google-play-scraper',
        version: playVersion,
        version_code: '',
        updated: playMeta.updated,
        url: playMeta.url,
        confidence: this.isUsableVersion(playVersion) ? 0.90 : 0.05,
        platform: 'google-play-public',
        note: this.isUsableVersion(playVersion)
          ? 'Google Play exposed a concrete public version. APKMirror Android TV discovery was still checked.'
          : `Google Play version was "${playVersion || 'blank'}". This is metadata only; APKMirror Android TV discovery was tried.`,
      }));
    } catch (error) {
      notes.push(`google-play-scraper failed: ${error.message || 'Unknown error'}`);
      candidates.push(this.makeCandidate({ source: 'google-play-scraper', error: error.message || 'Unknown error' }));
    }

    // Direct Google Play HTML sometimes exposes extra metadata, but often still does not expose a TV version.
    await this.safeAddCandidates(candidates, notes, 'google-play-html', () => this.lookupGooglePlayHtml(packageName));

    // Main source for real Android TV versions: programmatically discovered APKMirror Android TV listings.
    await this.safeAddCandidates(candidates, notes, 'apkmirror-programmatic', () => this.lookupApkMirrorProgrammatic(packageName, playMeta.title, playMeta.developer));

    // Lower-ranked fallbacks. These can be useful, but they can also return generic/mobile branches.
    await this.safeAddCandidates(candidates, notes, 'aptoide-getmeta', () => this.lookupAptoideGetMeta(packageName));
    await this.safeAddCandidates(candidates, notes, 'aptoide-search', () => this.lookupAptoideSearch(packageName));
    await this.safeAddCandidates(candidates, notes, 'apkpure-html', () => this.lookupApkPureHtml(packageName, playMeta.title));
    await this.safeAddCandidates(candidates, notes, 'aptoide-html', () => this.lookupAptoideHtml(packageName, playMeta.title));

    const winner = this.pickBestCandidate(candidates);
    if (winner && winner.usable) {
      return this.successResult(playMeta, winner, candidates, notes);
    }

    return {
      ok: false,
      ...playMeta,
      version: null,
      google_play_version: candidates.find(c => c.source === 'google-play-scraper')?.version || null,
      source: '',
      source_url: '',
      confidence: 0,
      error: this.buildSummary(candidates, notes) || 'No usable Android TV version found.',
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
      rank_score: winner.rank_score || null,
      warning: this.buildSummary(candidates.filter(c => !c.usable || c.source !== winner.source), notes),
      candidates,
    };
  }

  async safeAddCandidates(candidates, notes, label, fn) {
    try {
      const result = await fn();
      if (Array.isArray(result)) {
        candidates.push(...result);
      } else if (Array.isArray(result?.candidates)) {
        candidates.push(...result.candidates);
      } else if (result) {
        candidates.push(this.makeCandidate({ source: label, ...result }));
      }
    } catch (error) {
      const message = error.message || 'Unknown error';
      notes.push(`${label} failed: ${message}`);
      candidates.push(this.makeCandidate({ source: label, error: message }));
    }
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
      confidence: this.isUsableVersion(version) ? 0.76 : 0.04,
      platform: 'google-play-public',
      note: this.isUsableVersion(version) ? 'Direct Google Play HTML exposed a usable version.' : 'Direct Google Play HTML did not expose a usable version.',
    })];
  }

  async lookupApkMirrorProgrammatic(packageName, title, developer) {
    const discovered = await this.discoverApkMirrorTvListings(packageName, title, developer);
    const out = [...discovered.diagnostics];

    if (!discovered.urls.length) {
      out.push(this.makeCandidate({
        source: 'apkmirror-programmatic',
        error: 'No APKMirror Android TV listing URL was discovered programmatically.',
      }));
      return out;
    }

    for (const item of discovered.urls) {
      const baseUrl = item.url;
      const targets = [
        { url: baseUrl, via: 'direct', confidence: 0.985 },
        { url: `https://r.jina.ai/${baseUrl}`, via: 'jina-reader', confidence: 0.965 },
      ];

      for (const target of targets) {
        try {
          const text = await this.fetchText(target.url, {
            'User-Agent': PLAY_UA,
            'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
            Accept: 'text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Referer: 'https://www.google.com/',
          });

          const parsed = this.extractApkMirrorTvCandidates(text, baseUrl, target.confidence, target.via, item.discovery_score, title, developer);
          if (parsed.length) out.push(...parsed);
          else out.push(this.makeCandidate({
            source: 'apkmirror-programmatic',
            url: target.url,
            platform: 'android-tv-listing',
            error: `Discovered APKMirror Android TV listing fetched, but no Android TV version was parsed (${target.via}).`,
          }));
        } catch (error) {
          out.push(this.makeCandidate({
            source: 'apkmirror-programmatic',
            url: target.url,
            platform: 'android-tv-listing',
            error: error.message || `APKMirror Android TV listing fetch failed (${target.via})`,
          }));
        }
      }
    }
    return out;
  }

  async discoverApkMirrorTvListings(packageName, title, developer) {
    const diagnostics = [];
    const found = new Map();
    const displayTitle = String(title || packageName || '').trim();
    const displayDeveloper = String(developer || '').trim();
    const firstTitlePart = String(displayTitle).split(/[:–—-]/)[0].trim();

    const queries = Array.from(new Set([
      `"${displayTitle}" "Android TV" "APKMirror"`,
      `"${displayTitle}" "(Android TV)" site:apkmirror.com/apk`,
      `"${firstTitlePart}" "Android TV" "APKMirror"`,
      displayDeveloper ? `"${displayDeveloper}" "${firstTitlePart}" "Android TV" "APKMirror"` : '',
      `${packageName} "Android TV" "APKMirror"`,
      `${displayTitle} ${packageName} "Android TV" "APKMirror"`,
    ].filter(Boolean)));

    for (const query of queries) {
      const searchUrl = `https://s.jina.ai/${encodeURIComponent(query)}`;
      try {
        const text = await this.fetchText(searchUrl, {
          'User-Agent': PLAY_UA,
          'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
          Accept: 'text/plain,*/*;q=0.8',
        });

        const urls = this.extractApkMirrorListingUrls(text, packageName, displayTitle, displayDeveloper);
        for (const item of urls) {
          const existing = found.get(item.url);
          if (!existing || item.discovery_score > existing.discovery_score) found.set(item.url, item);
        }
      } catch (error) {
        diagnostics.push(this.makeCandidate({
          source: 'apkmirror-discovery',
          url: searchUrl,
          error: error.message || 'APKMirror discovery search failed',
        }));
      }
    }

    const urls = Array.from(found.values())
      .sort((a, b) => b.discovery_score - a.discovery_score)
      .slice(0, 4);

    if (urls.length) {
      diagnostics.push(this.makeCandidate({
        source: 'apkmirror-discovery',
        version: '',
        usable: false,
        url: urls.map(u => u.url).join(' | '),
        note: `Discovered ${urls.length} APKMirror Android TV listing URL(s) programmatically.`,
      }));
    }

    return { urls, diagnostics };
  }

  extractApkMirrorListingUrls(text, packageName, title, developer) {
    const decoded = this.decode(text);
    const urls = new Map();

    const addCandidateUrl = (rawUrl, index = 0) => {
      if (!rawUrl) return;
      let url = String(rawUrl).replace(/[)>\]"'.,]+$/g, '').trim();
      if (!url.startsWith('https://www.apkmirror.com/apk/')) return;
      url = this.normaliseApkMirrorListingUrl(url);
      if (!url) return;

      const context = this.contextWindow(decoded, index, 360, 540);
      const score = this.scoreApkMirrorListingUrl(url, context, packageName, title, developer);
      if (score < 12) return;

      const existing = urls.get(url);
      const item = {
        url,
        discovery_score: score,
        discovery_context: context.slice(0, 500),
      };
      if (!existing || score > existing.discovery_score) urls.set(url, item);
    };

    const rawUrlRegex = /https:\/\/www\.apkmirror\.com\/apk\/[A-Za-z0-9/_%.,+()\-]+\/?/gi;
    let match;
    while ((match = rawUrlRegex.exec(decoded)) !== null) {
      addCandidateUrl(match[0], match.index);
    }

    const markdownUrlRegex = /\((https:\/\/www\.apkmirror\.com\/apk\/[A-Za-z0-9/_%.,+()\-]+\/?)\)/gi;
    while ((match = markdownUrlRegex.exec(decoded)) !== null) {
      addCandidateUrl(match[1], match.index);
    }

    const relativeUrlRegex = /\((\/apk\/[A-Za-z0-9/_%.,+()\-]+\/?)\)/gi;
    while ((match = relativeUrlRegex.exec(decoded)) !== null) {
      addCandidateUrl(`https://www.apkmirror.com${match[1]}`, match.index);
    }

    return Array.from(urls.values());
  }

  scoreApkMirrorListingUrl(url, context, packageName, title, developer) {
    const haystack = `${url} ${context}`.toLowerCase();
    const path = (() => {
      try { return new URL(url).pathname.toLowerCase(); } catch (error) { return ''; }
    })();

    let score = 0;
    const hasTvSignal = /android[-_ ]?tv|\(\s*android\s*tv\s*\)|for\s+android\s+tv/i.test(haystack);
    if (!hasTvSignal) return 0;
    score += 12;

    if (/android-tv/i.test(path)) score += 12;
    if (/\(\s*android\s*tv\s*\)|android\s+tv/i.test(context)) score += 8;
    if (packageName && haystack.includes(String(packageName).toLowerCase())) score += 4;

    const titleTokens = this.importantTokens(title);
    const developerTokens = this.importantTokens(developer);
    const titleOverlap = titleTokens.filter(t => haystack.includes(t)).length;
    const developerOverlap = developerTokens.filter(t => haystack.includes(t)).length;
    score += Math.min(12, titleOverlap * 3);
    score += Math.min(10, developerOverlap * 4);

    // APKMirror paths are /apk/<developer>/<app-slug>/.
    // If both developer and title are weak, do not trust just any Android TV APKMirror result.
    if (titleTokens.length && titleOverlap === 0 && developerTokens.length && developerOverlap === 0) return 0;
    if (titleTokens.length >= 2 && titleOverlap === 0) score -= 8;

    return score;
  }

  extractApkMirrorTvCandidates(text, sourceUrl, confidence, via, discoveryScore, title, developer) {
    const decoded = this.decode(text);
    const out = [];
    const seen = new Set();
    const listingIsTv = /android[-_ ]?tv/i.test(String(sourceUrl || ''));
    const appScore = this.scoreApkMirrorListingUrl(sourceUrl, `${title || ''} ${developer || ''}`, '', title, developer);

    const addCandidate = (index, whole, version, versionCode = '') => {
      const cleanVersion = this.cleanVersion(version);
      if (!this.isUsableVersion(cleanVersion)) return;

      const context = this.contextWindow(decoded, index, 520, 760);
      const line = String(whole || '').trim();
      const combined = `${line} ${context} ${sourceUrl}`;

      let tvSignal = /\(\s*Android\s*TV\s*\)|Android\s+TV|for\s+Android\s+TV|android-tv/i.test(combined);

      // Naked Version/Latest rows must be tied back to an Android TV heading/title.
      const isNakedRow = /^(?:Latest|Version)\s*:/i.test(line);
      if (isNakedRow) {
        const heading = this.previousApkMirrorHeading(decoded, index);
        tvSignal = /\(\s*Android\s*TV\s*\)|Android\s+TV|for\s+Android\s+TV|android-tv/i.test(`${heading} ${sourceUrl}`);
      }

      if (!tvSignal) return;
      if (isNakedRow && !listingIsTv) return;

      const key = `${cleanVersion}:${versionCode || ''}:${sourceUrl}`;
      if (seen.has(key)) return;
      seen.add(key);

      out.push(this.makeCandidate({
        source: 'apkmirror-programmatic',
        version: cleanVersion,
        version_code: versionCode || '',
        updated: this.extractDateNear(decoded, index),
        url: sourceUrl,
        confidence: Math.min(0.995, confidence + Math.min(0.03, Number(discoveryScore || appScore || 0) / 1000)),
        platform: 'android-tv',
        note: `Programmatic APKMirror Android TV release parsed via ${via}.`,
      }));
    };

    // Line-first parsing is safer with Jina Reader/Search markdown.
    const lines = decoded.split(/\r?\n/);
    let offset = 0;
    for (const line of lines) {
      const lineStart = offset;
      offset += line.length + 1;
      if (!/android[-_ ]?tv|\(\s*Android\s*TV\s*\)|for\s+Android\s+TV/i.test(line + ' ' + sourceUrl)) continue;
      const rx = /\b([0-9]+(?:[._-][0-9]+){1,7})(?:\s+build\s+([0-9]{2,}))?\b/gi;
      let m;
      while ((m = rx.exec(line)) !== null) {
        addCandidate(lineStart + m.index, line, m[1], m[2] || '');
      }
    }

    // Fallback regexes for HTML/plain text blocks.
    const patterns = [
      /([^\n]{0,260}?\(\s*Android\s*TV\s*\)[^\n]{0,260}?\b([0-9]+(?:[._-][0-9]+){1,7})(?:\s+build\s+([0-9]{2,}))?[^\n]*)/gi,
      /(Download\s+[^\n]{0,260}?Android\s+TV[^\n]{0,260}?\b([0-9]+(?:[._-][0-9]+){1,7})(?:\s+build\s+([0-9]{2,}))?[^\n]*)/gi,
      /(Latest\s*:\s*([0-9]+(?:[._-][0-9]+){1,7})(?:\s+build\s+([0-9]{2,}))?[^\n]{0,120})/gi,
      /(Version\s*:\s*([0-9]+(?:[._-][0-9]+){1,7})(?:\s+build\s+([0-9]{2,}))?[^\n]{0,100})/gi,
    ];

    for (const regex of patterns) {
      let match;
      while ((match = regex.exec(decoded)) !== null) {
        addCandidate(match.index, String(match[1] || match[0] || ''), match[2] || '', match[3] || '');
      }
    }

    return out;
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
          confidence: foundPackage === packageName && this.isUsableVersion(version) ? 0.55 : 0.10,
          platform: 'generic-public-fallback',
          note: foundPackage && foundPackage !== packageName ? `Package mismatch: ${foundPackage}` : 'Exact package lookup from Aptoide API. Lower ranked because it may be a generic/mobile track.',
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
            confidence: this.isUsableVersion(version) ? 0.50 : 0,
            platform: 'generic-public-fallback',
            note: 'Aptoide search matched exact package name. Lower ranked because it may be a generic/mobile track.',
          }));
        }
        if (!matched) out.push(this.makeCandidate({ source: 'aptoide-search', url, error: 'No exact package match in Aptoide search results.' }));
      } catch (error) {
        out.push(this.makeCandidate({ source: 'aptoide-search', url, error: error.message || 'Aptoide search failed' }));
      }
    }
    return out;
  }

  async lookupApkPureHtml(packageName, title) {
    const urls = this.apkpureUrls(packageName, title);
    const out = [];
    for (const url of urls) {
      try {
        const html = await this.fetchText(url, {
          'User-Agent': PLAY_UA,
          'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: 'https://www.google.com/',
        });
        const version = this.cleanVersion(this.extractFirst(this.decode(html), [
          /Latest\s+Version\s+([0-9][0-9A-Za-z._-]{0,40})/i,
          /Latest\s+Version[\s\S]{0,300}?([0-9]+(?:[._-][0-9A-Za-z]+){1,6})/i,
          /What's\s+New\s+in\s+the\s+Latest\s+Version\s+([0-9][0-9A-Za-z._-]{0,40})/i,
          /Download[^<]{0,160}?\s([0-9]+(?:[._-][0-9A-Za-z]+){1,6})\s+APK/i,
          /versionName["']?\s*[:=]\s*["']([0-9][0-9A-Za-z._-]{0,40})/i,
        ]));
        out.push(this.makeCandidate({
          source: 'apkpure-html',
          version,
          version_code: this.extractFirst(html, [/(?:Version\s+Code|versionCode)[^0-9]{0,30}([0-9]{2,})/i]),
          updated: this.extractFirst(html, [/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+20\d{2}/i]),
          url,
          confidence: this.isUsableVersion(version) ? (/download\/tv/i.test(url) ? 0.68 : 0.45) : 0,
          platform: /download\/tv/i.test(url) ? 'possible-android-tv' : 'generic-public-fallback',
          note: this.isUsableVersion(version) ? 'APKPure HTML parsed. Lower ranked than APKMirror Android TV.' : 'APKPure page returned but no usable version was parsed.',
        }));
      } catch (error) {
        out.push(this.makeCandidate({ source: 'apkpure-html', url, error: error.message || 'APKPure fetch failed' }));
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
          confidence: this.isUsableVersion(version) ? 0.50 : 0,
          platform: 'generic-public-fallback',
          note: this.isUsableVersion(version) ? 'Aptoide HTML parsed. Lower ranked than APKMirror Android TV.' : 'Aptoide page returned but no usable version was parsed.',
        }));
      } catch (error) {
        out.push(this.makeCandidate({ source: 'aptoide-html', url, error: error.message || 'Aptoide HTML fetch failed' }));
      }
    }
    return out;
  }

  makeCandidate({ source, version = '', version_code = '', updated = '', url = '', confidence = 0, platform = '', note = '', error = '' }) {
    const clean = this.cleanVersion(version);
    const usable = this.isUsableVersion(clean);
    return {
      source,
      version: clean || null,
      version_code: version_code || null,
      usable,
      confidence: usable ? Number(confidence || 0.5) : 0,
      platform: platform || null,
      updated: updated || null,
      url: url || null,
      note: error || note || '',
    };
  }

  pickBestCandidate(candidates) {
    const usable = candidates.filter(c => c.usable && this.isUsableVersion(c.version));
    if (!usable.length) return null;

    const ranked = usable
      .map(c => ({ ...c, rank_score: this.rankCandidate(c, usable) }))
      .sort((a, b) => {
        const rankDiff = Number(b.rank_score || 0) - Number(a.rank_score || 0);
        if (Math.abs(rankDiff) > 15) return rankDiff;

        // Version is only a tie-breaker within similarly trusted/platform-specific candidates.
        const versionDiff = this.compareVersions(b.version, a.version);
        if (versionDiff !== 0) return versionDiff;

        if (Math.abs(rankDiff) > 0.001) return rankDiff;
        const confidenceDiff = Number(b.confidence || 0) - Number(a.confidence || 0);
        if (Math.abs(confidenceDiff) > 0.001) return confidenceDiff;
        return String(a.source || '').localeCompare(String(b.source || ''));
      });

    const winner = ranked[0];
    if (!winner) return null;
    return { ...winner, selected_reason: this.explainSelection(winner, ranked) };
  }

  rankCandidate(candidate, allUsable = []) {
    const source = String(candidate.source || '');
    const platform = String(candidate.platform || '');
    const url = String(candidate.url || '');
    const note = String(candidate.note || '');
    const hasTvSignal = /android[-_ ]?tv|for[-_ ]?android[-_ ]?tv|download\/tv/i.test(`${url} ${note} ${platform}`);
    let score = 0;

    if (source === 'apkmirror-programmatic' && platform === 'android-tv') score += 220;
    else if (source === 'apkmirror-programmatic' && hasTvSignal) score += 190;
    else if (source === 'google-play-scraper') score += 105;
    else if (source === 'google-play-html') score += 80;
    else if (source === 'apkpure-html' && hasTvSignal) score += 70;
    else if (source === 'apkpure-html') score += 45;
    else if (source === 'aptoide-html') score += 42;
    else if (source === 'aptoide-getmeta') score += 36;
    else if (source === 'aptoide-search') score += 32;
    else score += 20;

    if (hasTvSignal) score += 20;
    if (platform === 'generic-public-fallback') score -= 8;
    score += Number(candidate.confidence || 0) * 8;

    // Multiple independent sources agreeing is useful, but never enough to outrank APKMirror TV by itself.
    const sameVersionCount = allUsable.filter(c => c.version === candidate.version).length;
    score += Math.min(8, sameVersionCount * 2);

    return Number(score.toFixed(3));
  }

  explainSelection(winner, ranked) {
    const otherVersions = Array.from(new Set(ranked.filter(c => c.version !== winner.version).map(c => c.version))).filter(Boolean);
    const top = ranked.slice(0, 5).map(c => `${c.version} from ${c.source}${c.platform ? `/${c.platform}` : ''} score ${c.rank_score}`).join('; ');
    if (!otherVersions.length) return `Selected ${winner.version} because it was the only usable version found. Top candidates: ${top}.`;
    return `Selected ${winner.version} because Android TV-specific source/platform relevance ranked highest. Other versions seen: ${otherVersions.join(', ')}. Top candidates: ${top}.`;
  }

  buildSummary(candidates, notes) {
    const candidateNotes = candidates.slice(0, 28).map(c => `${c.source}${c.platform ? `/${c.platform}` : ''}: ${c.version || 'none'}${c.note ? ` (${c.note})` : ''}`);
    return [...notes, ...candidateNotes].filter(Boolean).join(' | ');
  }

  apkpureUrls(packageName, title) {
    const slugs = new Set();
    const titleSlug = this.slugify(title);
    const firstPartSlug = this.slugify(String(title || '').split(/[:–—-]/)[0]);
    const firstWordSlug = this.slugify(String(title || '').split(/[\s:–—-]+/)[0]);
    [titleSlug, firstPartSlug, firstWordSlug].forEach(slug => { if (slug) slugs.add(slug); });

    const urls = [];
    for (const slug of slugs) {
      urls.push(`https://apkpure.com/${slug}/${encodeURIComponent(packageName)}/download/tv`);
      urls.push(`https://apkpure.com/${slug}/${encodeURIComponent(packageName)}/download`);
      urls.push(`https://apkpure.com/${slug}/${encodeURIComponent(packageName)}`);
    }
    return Array.from(new Set(urls));
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
    return Array.from(new Set(urls));
  }

  normaliseApkMirrorListingUrl(url) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      const apkIndex = parts.indexOf('apk');
      if (apkIndex < 0 || parts.length < apkIndex + 3) return '';
      const cleanPath = `/${parts.slice(0, apkIndex + 3).join('/')}/`;
      return `https://www.apkmirror.com${cleanPath}`;
    } catch (error) {
      return '';
    }
  }

  previousApkMirrorHeading(text, index) {
    const before = String(text || '').slice(Math.max(0, Number(index || 0) - 900), Number(index || 0));
    const lines = before.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (/android[-_ ]?tv|\(\s*android\s*tv\s*\)/i.test(line)) return line;
      if (/^(?:#{1,6}\s*)/.test(line) || /Image:/.test(line) || /variants$/i.test(line)) return line;
    }
    return lines.slice(-4).join(' ');
  }

  extractDateNear(text, index) {
    const start = Math.max(0, Number(index || 0) - 180);
    const end = Math.min(String(text || '').length, Number(index || 0) + 300);
    const windowText = String(text || '').slice(start, end);
    return this.extractFirst(windowText, [/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+20\d{2}/i, /20\d{2}-\d{2}-\d{2}/i]);
  }

  contextWindow(text, index, before = 220, after = 320) {
    const source = String(text || '');
    const idx = Math.max(0, Number(index || 0));
    return source.slice(Math.max(0, idx - before), Math.min(source.length, idx + after));
  }

  importantTokens(value) {
    return Array.from(new Set(String(value || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/\+/g, ' plus ')
      .split(/[^a-z0-9]+/)
      .filter(token => token.length >= 2 && !STOP_WORDS.has(token))));
  }

  playUrl(packageName) {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=${encodeURIComponent(this.language)}&gl=${encodeURIComponent(this.country.toUpperCase())}`;
  }

  async fetchText(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
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
    return version.replace(/^v(?=\d)/i, '').trim();
  }

  isUsableVersion(version) {
    const v = String(version || '').trim();
    if (!v) return false;
    if (/^(vary|varies|varies with device|n\/a|unknown|null|undefined)$/i.test(v)) return false;
    return /^\d+(?:[._-]\d+){0,7}(?:[A-Za-z0-9._-]*)?$/.test(v);
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
