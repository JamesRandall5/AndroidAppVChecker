const PROVIDER_BUILD = 'google-play-provider-production-apkmirror-url-tv-safe-1.3.1';

const PLAY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const APKMIRROR_HOST_RE = /(^|\.)apkmirror\.com$/i;

class AndroidTvVersionProvider {
  constructor({ language = 'en', country = 'gb', timeoutMs = 30000 } = {}) {
    this.language = String(language || 'en');
    this.country = String(country || 'gb');
    this.timeoutMs = Math.max(8000, Math.min(Number(timeoutMs || 30000), 45000));
    this.gplayModule = null;
  }

  async loadScraper() {
    if (this.gplayModule) return this.gplayModule;
    const imported = await import('google-play-scraper');
    this.gplayModule = imported.default || imported;
    return this.gplayModule;
  }

  async lookup({ packageName, apkMirrorTvUrl }) {
    const candidates = [];
    const notes = [];
    const meta = { package_name: packageName, title: '', developer: '', updated: '', url: this.playUrl(packageName) };

    await this.safeAdd(candidates, notes, 'google-play-scraper', async () => {
      const gplay = await this.loadScraper();
      const app = await gplay.app({ appId: packageName, lang: this.language, country: this.country });
      meta.title = String(app?.title || '');
      meta.developer = String(app?.developer || app?.developerName || '');
      meta.updated = this.normaliseUpdated(app?.updated || app?.released || '');
      meta.url = String(app?.url || this.playUrl(packageName));
      const version = this.cleanVersion(app?.version || '');
      return [this.candidate({
        source: 'google-play-scraper',
        version,
        updated: meta.updated,
        url: meta.url,
        usable: false,
        tv_confirmed: false,
        note: this.isUsableVersion(version)
          ? 'Google Play exposed a public version, but final selection requires APKMirror Android TV evidence.'
          : `Google Play version was "${version || 'blank'}". This is metadata only.`,
      })];
    });

    let normalised;
    try {
      normalised = this.normaliseApkMirrorListingUrl(apkMirrorTvUrl);
    } catch (error) {
      return this.failure(meta, candidates, notes, 'needs_source_setup', error.message || 'APKMirror Android TV URL required.', '');
    }

    await this.safeAdd(candidates, notes, 'apkmirror-tv-url', () => this.lookupApkMirrorUrl(normalised, meta));

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
        source_url: winner.url || normalised.listing_url,
        apk_mirror_tv_url: normalised.listing_url,
        confidence: winner.confidence,
        tv_evidence: winner.tv_evidence,
        selected_reason: 'Selected highest confirmed Android TV version from supplied APKMirror listing URL.',
        warning: this.summary(candidates.filter(c => c !== winner), notes),
        candidates,
      };
    }

    return this.failure(
      meta,
      candidates,
      notes,
      'needs_review',
      'No confirmed Android TV version could be parsed from the supplied APKMirror TV URL. Generic/mobile versions were not selected.',
      normalised.listing_url
    );
  }

  async lookupApkMirrorUrl(normalised, meta = {}) {
    const searchQueries = this.buildApkMirrorSearchQueries(normalised, meta);
    const targets = [
      { method: 'direct', url: normalised.listing_url, confidence: 0.98, kind: 'html' },
      { method: 'jina-reader', url: `https://r.jina.ai/${normalised.listing_url}`, confidence: 0.96, kind: 'reader' },
      ...searchQueries.map((query, index) => ({
        method: `jina-search-${index + 1}`,
        url: `https://s.jina.ai/${encodeURIComponent(query)}`,
        confidence: 0.94 - (index * 0.02),
        kind: 'search',
      })),
    ];
    const out = [];

    for (const target of targets) {
      try {
        const text = await this.fetchText(target.url, {
          'User-Agent': PLAY_UA,
          'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
          Accept: target.kind === 'reader' || target.kind === 'search'
            ? 'text/plain,*/*;q=0.8'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain,*/*;q=0.8',
          Referer: 'https://www.google.com/',
        });
        const parsed = this.extractTvCandidates(text, normalised, target);
        if (parsed.length) out.push(...parsed);
        else out.push(this.candidate({ source: 'apkmirror-tv-url', url: target.url, error: `${target.method}: fetched but no TV release version parsed` }));
      } catch (error) {
        out.push(this.candidate({ source: 'apkmirror-tv-url', url: target.url, error: `${target.method}: ${error.message || 'fetch failed'}` }));
      }
    }

    return out;
  }

  buildApkMirrorSearchQueries(normalised, meta = {}) {
    const title = String(meta.title || '').replace(/[:|]+/g, ' ').replace(/\s+/g, ' ').trim();
    const slugWords = String(normalised.app_slug || '').replace(/-/g, ' ').trim();
    const path = `site:apkmirror.com/apk/${normalised.developer_slug}/${normalised.app_slug}`;
    const queries = [];
    if (title) queries.push(`${path} "Android TV" "${title}" "Version"`);
    queries.push(`${path} "Android TV" "Version"`);
    queries.push(`site:apkmirror.com ${slugWords} "Android TV" "Version"`);
    return [...new Set(queries)].slice(0, 3);
  }

  extractTvCandidates(text, normalised, target) {
    const body = String(text || '');
    const plain = this.toPlainText(body);
    const listingHasTvHint = /android[-\s]*tv/i.test(normalised.listing_url) || /android[-\s]*tv/i.test(normalised.app_slug);
    const out = [];
    const seen = new Set();
    let urlCandidateCount = 0;

    for (const item of this.extractReleaseUrls(body, normalised)) {
      const info = this.versionFromReleaseSlug(item.release_slug, normalised.app_slug);
      if (!this.isUsableVersion(info.version)) continue;
      const context = this.toPlainText(this.contextAround(body, item.raw, 600));
      const tvConfirmed = listingHasTvHint || /\bAndroid\s*TV\b|\(Android\s*TV\)|android[-\s]*tv/i.test(context) || /android[-\s]*tv/i.test(item.release_slug);
      if (!tvConfirmed) continue;
      const key = `${info.version}:${info.version_code || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      urlCandidateCount += 1;
      out.push(this.candidate({
        source: 'apkmirror-tv-url',
        version: info.version,
        version_code: info.version_code || '',
        updated: this.updatedFromText(context),
        url: item.absolute_url,
        usable: true,
        tv_confirmed: true,
        confidence: target.confidence,
        tv_evidence: listingHasTvHint ? 'Supplied APKMirror listing URL contains android-tv.' : 'Release context contains Android TV.',
        note: `Parsed APKMirror release URL via ${target.method}.`,
      }));
    }

    const lines = plain.split(/\r?\n/).map(v => v.trim()).filter(Boolean);

    // Reader/search fallbacks often split the app title and Version line.
    // Use a small context window so confirmed Android TV snippets are still parsed,
    // while generic/mobile-only snippets remain rejected.
    for (let i = 0; i < lines.length; i += 1) {
      const chunk = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 6)).join(' ');
      if (!/\bAndroid\s*TV\b|\(Android\s*TV\)|android[-\s]*tv/i.test(chunk)) continue;
      if (!this.lineBelongsToListing(chunk, normalised.app_slug)) continue;
      const info = this.versionFromAndroidTvLine(chunk);
      const finalInfo = this.isUsableVersion(info.version) ? info : this.versionFromGenericLine(chunk, normalised.app_slug);
      if (!this.isUsableVersion(finalInfo.version)) continue;
      const key = `${finalInfo.version}:${finalInfo.version_code || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.candidate({
        source: 'apkmirror-tv-url',
        version: finalInfo.version,
        version_code: finalInfo.version_code || '',
        updated: this.updatedFromText(chunk),
        url: target.url,
        usable: true,
        tv_confirmed: true,
        confidence: Math.min(target.confidence, target.kind === 'search' ? 0.92 : 0.94),
        tv_evidence: `Reader/search text contains Android TV and belongs to supplied APKMirror listing (${target.method}).`,
        note: `Parsed Android TV search/reader text via ${target.method}.`,
      }));
    }

    for (const line of lines) {
      if (!/\bAndroid\s*TV\b|\(Android\s*TV\)|android[-\s]*tv/i.test(line)) continue;
      if (!this.lineBelongsToListing(line, normalised.app_slug)) continue;
      const info = this.versionFromAndroidTvLine(line);
      if (!this.isUsableVersion(info.version)) continue;
      const key = `${info.version}:${info.version_code || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.candidate({
        source: 'apkmirror-tv-url',
        version: info.version,
        version_code: info.version_code || '',
        updated: this.updatedFromText(line),
        url: target.url,
        usable: true,
        tv_confirmed: true,
        confidence: Math.min(target.confidence, 0.94),
        tv_evidence: 'Line/title contains Android TV and belongs to the supplied APKMirror listing.',
        note: `Parsed Android TV title/version text via ${target.method}.`,
      }));
    }

    // Last-resort plain release line parsing, only when the supplied URL is TV-specific and URL extraction found nothing.
    if (listingHasTvHint && urlCandidateCount === 0) {
      for (const line of lines) {
        if (!/\bAPK\b|release|download|build|Version/i.test(line)) continue;
        if (!this.lineBelongsToListing(line, normalised.app_slug)) continue;
        const info = this.versionFromGenericLine(line, normalised.app_slug);
        if (!this.isUsableVersion(info.version)) continue;
        const key = `${info.version}:${info.version_code || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(this.candidate({
          source: 'apkmirror-tv-url',
          version: info.version,
          version_code: info.version_code || '',
          updated: this.updatedFromText(line),
          url: target.url,
          usable: true,
          tv_confirmed: true,
          confidence: Math.min(target.confidence, 0.90),
          tv_evidence: 'Supplied APKMirror listing URL contains android-tv and line contains release/version text.',
          note: `Parsed plain version text via ${target.method}.`,
        }));
      }
    }

    return this.uniqueBy(out, c => `${c.source}:${c.version}:${c.version_code}:${c.url}`);
  }

  extractReleaseUrls(text, normalised) {
    const out = [];
    const base = new URL(normalised.listing_url);
    const basePath = base.pathname.replace(/\/+$/, '') + '/';
    const pattern = /(?:href=["']([^"']+)["']|https?:\/\/www\.apkmirror\.com\/apk\/[^\s"'<>\)]+)/gi;
    let match;
    while ((match = pattern.exec(String(text || '')))) {
      const raw = match[1] || match[0];
      let absolute;
      try { absolute = new URL(raw.replace(/^href=["']?/i, ''), normalised.listing_url); } catch (_) { continue; }
      if (!APKMIRROR_HOST_RE.test(absolute.hostname)) continue;
      if (!absolute.pathname.startsWith(basePath)) continue;
      const parts = absolute.pathname.split('/').filter(Boolean);
      if (parts.length < 4 || parts[0] !== 'apk' || parts[2] !== normalised.app_slug) continue;
      const releaseSlug = parts[3];
      if (!releaseSlug || releaseSlug === normalised.app_slug) continue;
      if (!/\d/.test(releaseSlug)) continue;
      out.push({ raw, release_slug: releaseSlug, absolute_url: `${absolute.origin}/${parts.slice(0, 4).join('/')}/` });
    }
    return this.uniqueBy(out, item => item.absolute_url);
  }

  normaliseApkMirrorListingUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('APKMirror Android TV listing URL is required for TV-safe checking.');
    let url;
    try { url = new URL(raw); } catch (_) { throw new Error('APKMirror TV URL is not a valid URL.'); }
    if (!APKMIRROR_HOST_RE.test(url.hostname)) throw new Error('APKMirror TV URL must be on apkmirror.com.');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[0] !== 'apk') throw new Error('APKMirror TV URL must be under /apk/{developer}/{app}/.');
    const developerSlug = parts[1];
    const appSlug = parts[2];
    return {
      listing_url: `https://www.apkmirror.com/apk/${developerSlug}/${appSlug}/`,
      developer_slug: developerSlug,
      app_slug: appSlug,
      original_url: raw,
    };
  }

  versionFromReleaseSlug(releaseSlug, listingSlug) {
    let rest = String(releaseSlug || '').toLowerCase();
    const slug = String(listingSlug || '').toLowerCase();
    if (slug && rest.startsWith(`${slug}-`)) rest = rest.slice(slug.length + 1);
    rest = rest.replace(/-android-apk.*$/, '').replace(/-apk.*$/, '').replace(/-release$/, '');
    const buildMatch = rest.match(/(?:^|-)build-(\d{2,})/i);
    const versionPart = buildMatch ? rest.slice(0, buildMatch.index) : rest;
    const match = versionPart.match(/(\d+(?:-\d+){1,5}(?:-(?:rc|beta|alpha)\d*)?)/i);
    return { version: match ? this.hyphenVersionToDotted(match[1]) : '', version_code: buildMatch?.[1] || '' };
  }

  versionFromAndroidTvLine(line) {
    const text = String(line || '').replace(/\s+/g, ' ');
    const patterns = [
      /\(\s*Android\s*TV\s*\)[^0-9]{0,220}(?:version\s*:?\s*)?([0-9]+(?:\.[0-9A-Za-z]+){1,5}(?:[-_](?:rc|beta|alpha)\d*)?)(?:\s*\((\d+)\)|\s+build\s+([0-9]+))?/i,
      /Android\s*TV[^0-9]{0,220}(?:version\s*:?\s*)?([0-9]+(?:\.[0-9A-Za-z]+){1,5}(?:[-_](?:rc|beta|alpha)\d*)?)(?:\s*\((\d+)\)|\s+build\s+([0-9]+))?/i,
      /android-tv[^0-9]{0,220}(?:version\s*:?\s*)?([0-9]+(?:[-.][0-9A-Za-z]+){1,5}(?:[-_](?:rc|beta|alpha)\d*)?)(?:[-\s]+build[-\s]+([0-9]+)|\s*\((\d+)\))?/i,
      /Version\s*:?\s*([0-9]+(?:\.[0-9A-Za-z]+){1,5}(?:[-_](?:rc|beta|alpha)\d*)?)\s*\((\d+)\).*Android\s*TV/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return { version: this.cleanVersion(match[1]), version_code: match[2] || match[3] || '' };
    }
    return { version: '', version_code: '' };
  }

  versionFromGenericLine(line, listingSlug) {
    const fromSlug = this.versionFromReleaseSlug(this.slugify(line), listingSlug);
    if (this.isUsableVersion(fromSlug.version)) return fromSlug;
    const text = String(line || '').replace(/\s+/g, ' ');
    const match = text.match(/(?:version\s*:?\s*)?([0-9]+(?:\.[0-9A-Za-z]+){1,5}(?:[-_](?:rc|beta|alpha)\d*)?)(?:\s*\((\d+)\)|\s+build\s+([0-9]+))?/i);
    return { version: match ? this.cleanVersion(match[1]) : '', version_code: match?.[2] || match?.[3] || '' };
  }

  lineBelongsToListing(line, listingSlug) {
    const source = String(line || '').toLowerCase();
    const slug = String(listingSlug || '').toLowerCase();
    if (!slug) return false;
    if (source.includes(`/${slug}/`) || source.includes(slug)) return true;
    if (/apkmirror\.com\/apk\//i.test(source)) return false;
    const stop = new Set(['android','tv','apk','app','apps','play','player','stream','streaming','shows','show','series','on','demand','for','the','and','free']);
    const tokens = slug.split('-').filter(t => t.length >= 3 && !stop.has(t));
    if (!tokens.length) return false;
    const hits = tokens.filter(t => source.includes(t)).length;
    return hits >= Math.min(2, tokens.length);
  }

  pickBestTvCandidate(candidates) {
    const usable = candidates
      .filter(c => c && c.usable && c.tv_confirmed && this.isUsableVersion(c.version))
      .sort((a, b) => {
        const versionCompare = this.compareVersions(b.version, a.version);
        if (versionCompare !== 0) return versionCompare;
        const buildCompare = Number(b.version_code || 0) - Number(a.version_code || 0);
        if (buildCompare !== 0) return buildCompare;
        return Number(b.confidence || 0) - Number(a.confidence || 0);
      });
    return usable[0] || null;
  }

  async safeAdd(candidates, notes, label, fn) {
    try {
      const result = await fn();
      if (Array.isArray(result)) candidates.push(...result);
      else if (result) candidates.push(this.candidate({ source: label, ...result }));
    } catch (error) {
      notes.push(`${label} failed: ${error.message || 'Unknown error'}`);
      candidates.push(this.candidate({ source: label, error: error.message || 'Unknown error' }));
    }
  }

  async fetchText(url, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return text;
    } finally {
      clearTimeout(timer);
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

  failure(meta, candidates, notes, status, error, apkMirrorUrl) {
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
    };
  }

  cleanVersion(value) {
    let version = this.decodeHtml(String(value || '').trim()).replace(/[\s,;]+$/g, '').replace(/_/g, '-');
    if (/^(vary|varies with device|depends on device|unknown|n\/a)$/i.test(version)) {
      return /^vary$/i.test(version) ? 'VARY' : '';
    }
    // Only strip a leading v when it is a semantic-version prefix, not from words like VARY.
    version = version.replace(/^version\s*:?\s*/i, '').replace(/^v(?=\d)/i, '').trim();
    if (/^(vary|varies with device|depends on device|unknown|n\/a)$/i.test(version)) {
      return /^vary$/i.test(version) ? 'VARY' : '';
    }
    return version;
  }

  isUsableVersion(value) {
    const version = this.cleanVersion(value);
    return /^[0-9]+(?:\.[0-9A-Za-z]+){1,5}(?:[-_](?:rc|beta|alpha)\d*)?$/.test(version);
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
    const [main, suffix = ''] = String(version || '').toLowerCase().split(/[-_]/, 2);
    return { numbers: main.split('.').map(v => Number.parseInt(v, 10)).filter(Number.isFinite), suffix };
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

  slugify(text) {
    return String(text || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

  playUrl(packageName) {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=${encodeURIComponent(this.language)}&gl=${encodeURIComponent(this.country)}`;
  }
}

module.exports = { AndroidTvVersionProvider, PROVIDER_BUILD };
