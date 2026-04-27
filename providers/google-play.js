// ANDROID TV RANKED CANDIDATES + APKMIRROR BUILD 1.0.7
// This file collects every public candidate and ranks them instead of returning the first usable result.
// Important behaviour: Google Play "VARY" is kept as diagnostic data only and is never returned as the final version.
// If fallback sources disagree, Android-TV/platform relevance wins first, then version number is used as a tie-breaker.

const PROVIDER_BUILD = 'google-play-provider-apkmirror-android-tv-ranked-1.0.7';

const PLAY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

const SOURCE_OVERRIDES = {
  'com.crunchyroll.crunchyroid': {
    apkpureSlugs: ['crunchyroll', 'crunchyroll-anime-streaming', 'crunchyroll-everything-anime-android-tv'],
    aptoideNames: ['crunchyroll'],
    apkmirrorPaths: ['/apk/crunchyroll-llc-2/crunchyroll-everything-anime-android-tv/'],
  },
  'com.spotify.tv.android': {
    apkpureSlugs: ['spotify-for-android-tv-app', 'spotify-music-podcasts', 'spotify'],
    aptoideNames: ['spotify', 'spotify-tv'],
    apkmirrorPaths: ['/apk/spotify-ab/spotify-music-android-tv/'],
  },
  'com.netflix.ninja': {
    apkpureSlugs: ['netflix', 'netflix-android-tv'],
    aptoideNames: ['netflix'],
    apkmirrorPaths: ['/apk/netflix-inc/netflix-android-tv/'],
  },
  'com.disney.disneyplus': {
    apkpureSlugs: ['disney', 'disney-plus', 'disney-android-tv'],
    aptoideNames: ['disney'],
    apkmirrorPaths: ['/apk/disney/disney-android-tv/'],
  },
};

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

    // 1) Google Play scraper: useful for metadata; often returns VARY for Android TV versions.
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
        confidence: this.isUsableVersion(playVersion) ? 0.97 : 0.05,
        note: this.isUsableVersion(playVersion)
          ? 'Google Play exposed a usable version.'
          : `Google Play version was "${playVersion || 'blank'}". This is metadata only; fallback sources were tried.`,
      }));
    } catch (error) {
      notes.push(`google-play-scraper failed: ${error.message || 'Unknown error'}`);
      candidates.push(this.makeCandidate({ source: 'google-play-scraper', error: error.message || 'Unknown error' }));
    }

    // If Google Play gives a real version, that is already enough.
    // For Android TV this often will not happen, so the fallbacks below are normally used.
    const initialWinner = this.pickBestCandidate(candidates);
    if (initialWinner && initialWinner.source === 'google-play-scraper' && initialWinner.usable) {
      return this.successResult(playMeta, initialWinner, candidates, notes);
    }

    // 2) Direct Google Play page parse. Usually also returns VARY, but it proves what the public page exposes.
    await this.safeAddCandidates(candidates, notes, 'google-play-html', () => this.lookupGooglePlayHtml(packageName));

    // 3) APKMirror Android TV listing fallback. This is usually the most useful public source
    // for Android TV when Google Play says VARY. We try direct fetch first, then Jina Reader
    // and Jina Search as a read/search proxy because APKMirror often blocks simple server fetches.
    await this.safeAddCandidates(candidates, notes, 'apkmirror-listing', () => this.lookupApkMirrorListing(packageName, playMeta.title));
    await this.safeAddCandidates(candidates, notes, 'apkmirror-search', () => this.lookupApkMirrorSearch(packageName, playMeta.title));

    // 4) Aptoide public JSON endpoints. These are not Google Play, and for Android TV they can
    // return stale/generic tracks. They are kept as lower-ranked fallbacks only.
    await this.safeAddCandidates(candidates, notes, 'aptoide-getmeta', () => this.lookupAptoideGetMeta(packageName));
    await this.safeAddCandidates(candidates, notes, 'aptoide-search', () => this.lookupAptoideSearch(packageName));

    // 5) APKPure HTML fallback. This may be blocked from some hosts, but we capture the exact failure as a candidate.
    await this.safeAddCandidates(candidates, notes, 'apkpure-html', () => this.lookupApkPureHtml(packageName, playMeta.title));

    // 5) Aptoide public HTML fallback.
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
      error: this.buildSummary(candidates, notes) || 'No usable version found.',
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
      confidence: this.isUsableVersion(version) ? 0.86 : 0.04,
      note: this.isUsableVersion(version) ? 'Direct Google Play HTML exposed a usable version.' : 'Direct Google Play HTML did not expose a usable version.',
    })];
  }

  async lookupApkMirrorListing(packageName, title) {
    const urls = this.apkmirrorUrls(packageName, title);
    const out = [];
    for (const baseUrl of urls) {
      const fetchTargets = [
        { url: baseUrl, via: 'direct', confidence: 0.98 },
        { url: `https://r.jina.ai/${baseUrl}`, via: 'jina-reader', confidence: 0.96 },
      ];
      for (const target of fetchTargets) {
        try {
          const text = await this.fetchText(target.url, {
            'User-Agent': PLAY_UA,
            'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
            Accept: 'text/plain,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Referer: 'https://www.google.com/',
          });
          const parsed = this.extractApkMirrorCandidates(text, baseUrl, 'apkmirror-listing', target.confidence, target.via);
          if (parsed.length) out.push(...parsed);
          else out.push(this.makeCandidate({
            source: 'apkmirror-listing',
            url: target.url,
            error: `No Android TV release version parsed from APKMirror listing (${target.via}).`,
          }));
        } catch (error) {
          out.push(this.makeCandidate({ source: 'apkmirror-listing', url: target.url, error: error.message || `APKMirror listing fetch failed (${target.via})` }));
        }
      }
    }
    return out;
  }

  async lookupApkMirrorSearch(packageName, title) {
    const displayTitle = String(title || packageName || '').trim();
    const queries = [
      `${displayTitle} Android TV APKMirror latest version`,
      `${packageName} Android TV APKMirror`,
    ];
    const out = [];
    for (const query of queries) {
      const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
      try {
        const text = await this.fetchText(url, {
          'User-Agent': PLAY_UA,
          'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
          Accept: 'text/plain,*/*;q=0.8',
        });
        const parsed = this.extractApkMirrorCandidates(text, url, 'apkmirror-search', 0.94, 'jina-search');
        if (parsed.length) out.push(...parsed);
        else out.push(this.makeCandidate({ source: 'apkmirror-search', url, error: 'No Android TV APKMirror release version parsed from search output.' }));
      } catch (error) {
        out.push(this.makeCandidate({ source: 'apkmirror-search', url, error: error.message || 'APKMirror search fetch failed' }));
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
          confidence: foundPackage === packageName && this.isUsableVersion(version) ? 0.80 : 0.15,
          note: foundPackage && foundPackage !== packageName ? `Package mismatch: ${foundPackage}` : 'Exact package lookup from Aptoide API.',
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
            confidence: this.isUsableVersion(version) ? 0.74 : 0,
            note: 'Aptoide search matched exact package name.',
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
          confidence: this.isUsableVersion(version) ? 0.76 : 0,
          note: this.isUsableVersion(version) ? 'APKPure HTML parsed.' : 'APKPure page returned but no usable version was parsed.',
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
          confidence: this.isUsableVersion(version) ? 0.60 : 0,
          note: this.isUsableVersion(version) ? 'Aptoide HTML parsed.' : 'Aptoide page returned but no usable version was parsed.',
        }));
      } catch (error) {
        out.push(this.makeCandidate({ source: 'aptoide-html', url, error: error.message || 'Aptoide HTML fetch failed' }));
      }
    }
    return out;
  }

  makeCandidate({ source, version = '', version_code = '', updated = '', url = '', confidence = 0, note = '', error = '' }) {
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
      note: error || note || '',
    };
  }

  pickBestCandidate(candidates) {
    const usable = candidates.filter(c => c.usable && this.isUsableVersion(c.version));
    if (!usable.length) return null;

    // Google Play is the most authoritative source when it exposes a real version.
    // When it says VARY, it is only metadata and the fallback candidates must be ranked.
    const play = usable.find(c => c.source === 'google-play-scraper');
    if (play && this.isUsableVersion(play.version)) {
      return { ...play, selected_reason: 'Google Play exposed a concrete version.' };
    }

    // Android TV caveat:
    // Exact package-name JSON lookups can still return a stale/generic track. Crunchyroll
    // is the proof case: Aptoide JSON returns 2.6.0 while public app pages show 3.61.0.
    // So we rank every fallback candidate first by Android-TV/platform relevance and
    // source reliability, then use version number as a tie-breaker within close scores.
    const ranked = usable
      .map(c => ({ ...c, rank_score: this.rankCandidate(c, usable) }))
      .sort((a, b) => {
        const rankDiff = Number(b.rank_score || 0) - Number(a.rank_score || 0);
        if (Math.abs(rankDiff) > 12) return rankDiff;

        const versionDiff = this.compareVersions(b.version, a.version);
        if (versionDiff !== 0) return versionDiff;

        if (Math.abs(rankDiff) > 0.001) return rankDiff;
        const confidenceDiff = Number(b.confidence || 0) - Number(a.confidence || 0);
        if (Math.abs(confidenceDiff) > 0.001) return confidenceDiff;
        return String(a.source || '').localeCompare(String(b.source || ''));
      });

    const winner = ranked[0];
    if (!winner) return null;
    return {
      ...winner,
      selected_reason: this.explainSelection(winner, ranked),
    };
  }

  rankCandidate(candidate, allUsable = []) {
    const source = String(candidate.source || '');
    const url = String(candidate.url || '');
    const note = String(candidate.note || '');
    let score = 0;

    const hasTvSignal = /android[-_ ]?tv|for[-_ ]?android[-_ ]?tv/i.test(url + ' ' + note) || url.includes('/download/tv');
    const isHtml = source.includes('html');
    const isJson = source.includes('getmeta') || source.includes('search');

    // Source priority for Android TV mode. HTML/app pages and explicit TV URLs are more
    // useful than Aptoide JSON because JSON can return a generic/stale package track.
    if (source === 'google-play-scraper') score += 100;
    else if (source === 'apkmirror-listing' && hasTvSignal) score += 118;
    else if (source === 'apkmirror-search' && hasTvSignal) score += 112;
    else if (source === 'apkmirror-listing' || source === 'apkmirror-search') score += 92;
    else if (source === 'apkpure-html' && hasTvSignal) score += 96;
    else if (source === 'apkpure-html') score += 66;
    else if (source === 'aptoide-html') score += 86;
    else if (source === 'google-play-html') score += 65;
    else if (source === 'aptoide-getmeta') score += 48;
    else if (source === 'aptoide-search') score += 42;
    else score += 30;

    if (hasTvSignal) score += 18;
    if (isHtml) score += 8; // public app pages usually expose the consumer-visible release number.
    if (isJson) score -= 6; // exact package is useful, but not enough for Android TV latest.
    score += Number(candidate.confidence || 0) * 6;

    const sameVersionCount = allUsable.filter(c => c.version === candidate.version).length;
    score += Math.min(8, sameVersionCount * 2);

    const maxVersion = allUsable
      .map(c => c.version)
      .filter(Boolean)
      .sort((a, b) => this.compareVersions(b, a))[0];
    if (maxVersion && candidate.version === maxVersion) score += 5;

    return Number(score.toFixed(3));
  }

  explainSelection(winner, ranked) {
    const otherVersions = Array.from(new Set(ranked.filter(c => c.version !== winner.version).map(c => c.version))).filter(Boolean);
    if (!otherVersions.length) return `Selected ${winner.version} because it was the only usable fallback version.`;
    const top = ranked.slice(0, 4).map(c => `${c.version} from ${c.source} score ${c.rank_score}`).join('; ');
    return `Selected ${winner.version} because Google Play returned VARY and this candidate ranked highest for Android TV relevance/source quality. Other versions seen: ${otherVersions.join(', ')}. Top candidates: ${top}.`;
  }

  buildSummary(candidates, notes) {
    const candidateNotes = candidates.slice(0, 20).map(c => `${c.source}: ${c.version || 'none'}${c.note ? ` (${c.note})` : ''}`);
    return [...notes, ...candidateNotes].filter(Boolean).join(' | ');
  }

  extractApkMirrorCandidates(text, sourceUrl, source, confidence, via) {
    const decoded = this.decode(text);
    const out = [];
    const seen = new Set();
    const patterns = [
      {
        regex: /(?:^|\n)\s*(?:#{1,6}\s*)?([^\n]{0,180}?\(Android TV\)[^\n]{0,180}?\b([0-9]+(?:[._-][0-9]+){1,6})(?:\s+build\s+([0-9]{2,}))?[^\n]*)/gi,
        wholeGroup: 1,
        versionGroup: 2,
        buildGroup: 3,
      },
      {
        regex: /Download\s+([^\n]{0,140}?\(Android TV\)[^\n]{0,140}?\b([0-9]+(?:[._-][0-9]+){1,6})(?:\s+build\s+([0-9]{2,}))?[^\n]*)/gi,
        wholeGroup: 1,
        versionGroup: 2,
        buildGroup: 3,
      },
      {
        regex: /Version\s*:\s*([0-9]+(?:[._-][0-9]+){1,6})(?:\s+build\s+([0-9]{2,}))?/gi,
        wholeGroup: 0,
        versionGroup: 1,
        buildGroup: 2,
      },
    ];
    for (const item of patterns) {
      let match;
      while ((match = item.regex.exec(decoded)) !== null) {
        const whole = String(match[item.wholeGroup] || match[0] || '');
        const version = this.cleanVersion(match[item.versionGroup] || '');
        const versionCode = match[item.buildGroup] || this.extractFirst(whole, [/\(([0-9]{3,})\)\s+for\s+Android/i, /build\s+([0-9]{2,})/i]);
        if (!this.isUsableVersion(version)) continue;
        // Search output can contain nearby non-TV results, so require an Android TV signal unless it came from a known APKMirror TV listing URL.
        const tvSignal = /android\s*tv/i.test(whole + ' ' + sourceUrl) || /netflix-android-tv|android-tv/i.test(sourceUrl);
        if (!tvSignal) continue;
        const key = `${source}:${version}:${versionCode || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(this.makeCandidate({
          source,
          version,
          version_code: versionCode || '',
          updated: this.extractDateNear(decoded, match.index),
          url: sourceUrl,
          confidence,
          note: `APKMirror Android TV release parsed via ${via}.`,
        }));
      }
    }
    return out;
  }

  extractDateNear(text, index) {
    const start = Math.max(0, Number(index || 0) - 160);
    const end = Math.min(String(text || '').length, Number(index || 0) + 260);
    const windowText = String(text || '').slice(start, end);
    return this.extractFirst(windowText, [/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+20\d{2}/i, /20\d{2}-\d{2}-\d{2}/i]);
  }

  apkmirrorUrls(packageName, title) {
    const override = SOURCE_OVERRIDES[packageName] || {};
    const paths = new Set(override.apkmirrorPaths || []);
    const urls = [];
    for (const path of paths) {
      const cleanPath = String(path || '').startsWith('/') ? String(path || '') : `/${path}`;
      urls.push(`https://www.apkmirror.com${cleanPath}`);
    }
    return Array.from(new Set(urls));
  }

  apkpureUrls(packageName, title) {
    const override = SOURCE_OVERRIDES[packageName] || {};
    const slugs = new Set(override.apkpureSlugs || []);
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
    const override = SOURCE_OVERRIDES[packageName] || {};
    const names = new Set(override.aptoideNames || []);
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
