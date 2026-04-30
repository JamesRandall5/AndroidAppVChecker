const PROVIDER_BUILD = 'google-play-provider-production-version-source-tv-safe-1.4.18';

const PLAY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const APKMIRROR_HOST_RE = /(^|\.)apkmirror\.com$/i;
const APKPURE_HOST_RE = /(^|\.)apkpure\.(?:com|net)$/i;
const APKFAB_HOST_RE = /(^|\.)apkfab\.com$/i;
const APTOIDE_HOST_RE = /(^|\.)aptoide\.com$/i;
const ANDROID_TV_RE = /android[\s-]*tv|\(\s*android\s*tv\s*\)/i;
const FIRE_TV_RE = /fire[\s-]*tv|amazon\s*fire/i;

class AndroidTvVersionProvider {
  constructor({ language = 'en', country = 'gb', timeoutMs = 30000 } = {}) {
    this.language = String(language || 'en');
    this.country = String(country || 'gb');
    // Keep source fetches bounded so a single app can return diagnostics quickly.
    this.timeoutMs = Math.max(5000, Math.min(Number(timeoutMs || 12000), 12000));
    this.gplayModule = null;
    this.hostLastFetchAt = new Map();
    this.hostBlockedUntil = new Map();
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
      const playWinner = this.pickBestTvCandidate(candidates, packageName);
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
      await this.safeAdd(candidates, notes, 'apkmirror-source-url', () => this.lookupApkMirrorSource(normalised, meta, packageName));
    } else if (normalised.source_type === 'apkpure') {
      await this.safeAdd(candidates, notes, 'apkpure-tv-url', () => this.lookupApkPureSource(normalised, meta, packageName));
    } else if (normalised.source_type === 'apkfab') {
      await this.safeAdd(candidates, notes, 'apkfab-version-url', () => this.lookupApkFabSource(normalised, meta, packageName));
    } else if (normalised.source_type === 'aptoide') {
      await this.safeAdd(candidates, notes, 'aptoide-version-url', () => this.lookupAptoideSource(normalised, meta, packageName));
    } else {
      return this.failure(meta, candidates, notes, 'needs_source_setup', 'Unsupported version source URL.', normalised.source_url || '');
    }

    const winner = this.pickBestTvCandidate(candidates, packageName);
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

  async lookupApkMirrorSource(normalised, meta = {}, packageName = '') {
    // Production-safe behaviour: fetch only the exact source URL supplied by 20i.
    // The source may be:
    //   /apk/{developer}/                      developer page with multiple apps
    //   /apk/{developer}/{app}/                Android TV app listing page
    //   /apk/{developer}/{app}/{release}/      specific Android TV release page
    //   /uploads/?appcategory=...              APKMirror uploads category page
    // We do not crawl broadly. For APKMirror app listing URLs that already contain an Android TV hint,
    // we may also fetch same-app variant filter pages because they often expose the release rows.
    const sourceUrl = normalised.source_url;
    const out = [];
    let jina429Seen = false;

    const exactSourceCandidate = this.candidateFromExactApkMirrorSourceUrl(normalised);
    if (exactSourceCandidate) out.push(exactSourceCandidate);

    const packageFallbackTargets = this.samePackageApkPureFallbackTargets(normalised, packageName);
    const targets = packageFallbackTargets.length ? packageFallbackTargets : [
      { method: 'direct-source-url', url: sourceUrl, confidence: 0.99, kind: 'html', timeout: 4000 },
      { method: 'jina-reader-source-url', url: `https://r.jina.ai/${sourceUrl}`, confidence: 0.97, kind: 'reader', timeout: 5000 },
      ...this.sameAppApkMirrorVariantTargets(normalised),
      ...this.sameDeveloperApkMirrorTargets(normalised),
    ];

    for (const target of targets) {
      if (jina429Seen && this.hostFromUrl(target.url) === 'r.jina.ai') {
        out.push(this.candidate({ source: target.source || 'apkmirror-source-url', url: target.url, error: `${target.method}: skipped after Jina HTTP 429 rate limit in this check` }));
        continue;
      }
      // Public search fallbacks are only needed until one confirmed Android TV
      // version is found. This avoids extra slow/block-prone requests and keeps
      // existing direct APKMirror/APKPure behaviour unchanged for apps that work.
      if (this.hasUsableTvCandidate(out)) break;
      try {
        const text = await this.fetchText(target.url, {
          'User-Agent': PLAY_UA,
          'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
          Accept: target.kind === 'reader'
            ? 'text/plain,*/*;q=0.8'
            : 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain,*/*;q=0.8',
          Referer: 'https://www.google.com/',
        }, target.timeout);
        if (this.looksLikeBlockedSecurityPage(text)) {
          out.push(this.candidate({ source: target.source || 'apkmirror-source-url', url: target.url, error: `${target.method}: fetched APKMirror security verification page; no release rows available` }));
          continue;
        }
        const parsed = target.kind === 'apkpure-tv-branch'
          ? this.extractKnownTvBranchApkPureFallbackCandidates(text, normalised, target, packageName)
          : this.extractTvCandidates(text, normalised, target, meta);
        if (parsed.length) out.push(...parsed);
        else out.push(this.candidate({ source: target.source || 'apkmirror-source-url', url: target.url, error: `${target.method}: fetched but no Android TV release row/link parsed` }));
      } catch (error) {
        if (this.hostFromUrl(target.url) === 'r.jina.ai' && /HTTP\s+429/i.test(String(error.message || ''))) {
          jina429Seen = true;
          this.blockHostTemporarily('r.jina.ai', 9000);
        }
        out.push(this.candidate({ source: target.source || 'apkmirror-source-url', url: target.url, error: `${target.method}: ${error.message || 'fetch failed'}` }));
      }
    }

    return out;
  }

  async lookupApkPureSource(normalised, meta = {}, packageName = '') {
    const sourceUrl = normalised.source_url;
    const alternateUrl = normalised.alternate_url || '';
    const packageFallbackTargets = this.samePackageApkPureFallbackTargets(normalised, packageName);
    const targets = packageFallbackTargets.length ? packageFallbackTargets : [
      { method: 'direct-source-url', url: sourceUrl, confidence: 0.96, kind: 'html', timeout: 7000 },
      { method: 'jina-reader-source-url', url: `https://r.jina.ai/${sourceUrl}`, confidence: 0.94, kind: 'reader', timeout: 12000 },
    ];
    if (!packageFallbackTargets.length && alternateUrl && alternateUrl !== sourceUrl) {
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
        const parsed = target.kind === 'apkpure-tv-branch'
          ? this.extractKnownTvBranchApkPureFallbackCandidates(text, normalised, target, packageName)
          : this.extractApkPureTvCandidates(text, normalised, target, meta, packageName);
        if (parsed.length) { out.push(...parsed); return out; }
        else out.push(this.candidate({ source: target.source || 'apkpure-tv-url', url: target.url, error: `${target.method}: fetched but no usable version parsed` }));
      } catch (error) {
        out.push(this.candidate({ source: target.source || 'apkpure-tv-url', url: target.url, error: `${target.method}: ${error.message || 'fetch failed'}` }));
      }
    }
    return out;
  }

  async lookupApkFabSource(normalised, meta = {}, packageName = '') {
    const sourceUrl = normalised.source_url;
    const targets = [
      { method: 'direct-source-url', url: sourceUrl, confidence: 0.86, kind: 'html', timeout: 5000 },
      { method: 'jina-reader-source-url', url: `https://r.jina.ai/${sourceUrl}`, confidence: 0.84, kind: 'reader', timeout: 5000 },
    ];

    // If the user supplies the normal APKFab app URL, try the matching /versions page too.
    if (normalised.versions_url && normalised.versions_url !== sourceUrl) {
      targets.push({ method: 'direct-derived-versions-url', url: normalised.versions_url, confidence: 0.85, kind: 'html', timeout: 5000 });
      targets.push({ method: 'jina-reader-derived-versions-url', url: `https://r.jina.ai/${normalised.versions_url}`, confidence: 0.83, kind: 'reader', timeout: 5000 });
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
        const parsed = this.extractApkFabCandidates(text, normalised, target, meta, packageName);
        if (parsed.length) { out.push(...parsed); return out; }
        out.push(this.candidate({ source: 'apkfab-version-url', url: target.url, error: `${target.method}: fetched but no usable APKFab version parsed` }));
      } catch (error) {
        out.push(this.candidate({ source: 'apkfab-version-url', url: target.url, error: `${target.method}: ${error.message || 'fetch failed'}` }));
      }
    }
    return out;
  }

  extractApkFabCandidates(text, normalised, target, meta = {}, packageName = '') {
    const raw = String(text || '');
    const plain = this.toPlainText(raw);
    const compact = plain.replace(/\s+/g, ' ').trim();
    const out = [];
    const seen = new Set();
    const pkg = String(packageName || '').trim().toLowerCase();
    const sourcePkg = String(normalised.package_from_path || '').trim().toLowerCase();

    // Stay package-scoped. APKFab paths are normally /app-slug/package.name/versions.
    if (pkg && sourcePkg && pkg !== sourcePkg) return out;
    if (pkg && !sourcePkg && !compact.toLowerCase().includes(pkg) && !normalised.source_url.toLowerCase().includes(pkg)) return out;

    const isTubiPackage = pkg === 'com.tubitv' || sourcePkg === 'com.tubitv' || /com\.tubitv/i.test(normalised.source_url);
    const trustedTvPage = Boolean(normalised.source_has_tv_hint || this.apkFabTitleHasTvEvidence(plain, normalised, meta));

    // General APKFab support remains TV-safe: for normal apps we only accept APKFab pages
    // that are themselves TV-scoped. Tubi is the one controlled exception because APKFab
    // exposes the TV branch as x.y.5xxx without labelling it Android TV.
    if (!trustedTvPage && !isTubiPackage) return out;

    const lines = plain.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const match = line.match(/\b([0-9]+(?:\.[0-9]+){1,5}(?:[-+](?:rc|beta|alpha)\d*)?)\s+(?:XAPK\s+APKs|XAPK|APK\s+Bundle|APK|APKs)\b/i);
      if (!match) continue;
      const version = this.cleanVersion(match[1]);
      if (!this.isUsableVersion(version)) continue;
      const context = [lines[i - 1] || '', line, lines[i + 1] || '', lines[i + 2] || '', lines[i + 3] || '', lines[i + 4] || ''].join(' ');
      if (this.isFireTvContext(context)) continue;

      let accept = false;
      let evidence = '';
      let confidence = target.confidence;
      if (isTubiPackage) {
        // Tubi-specific branch rule. This intentionally ignores APKFab's newer mobile x.y.z
        // rows and accepts only the branch currently used by the Android TV package.
        accept = /^[0-9]+\.[0-9]+\.5[0-9]{3,}$/.test(version);
        evidence = 'APKFab Tubi controlled fallback: accepted only the x.y.5xxx TV-style branch and ignored generic/mobile x.y.z rows.';
        confidence = Math.min(target.confidence, 0.83);
      } else if (trustedTvPage) {
        accept = true;
        evidence = `APKFab source page is TV-scoped and exposes a version-history row (${target.method}).`;
      }
      if (!accept) continue;

      const key = `${version}:${target.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.candidate({
        source: 'apkfab-version-url',
        version,
        version_code: '',
        updated: this.updatedFromText(context),
        url: target.url,
        usable: true,
        tv_confirmed: true,
        confidence,
        tv_evidence: evidence,
        note: `Parsed APKFab version-history row via ${target.method}.`,
      }));
    }

    // Some reader/search-like text can flatten the list; keep a fallback regex for that shape.
    if (!out.length && isTubiPackage) {
      const pattern = /Tubi\s+-?\s*Movies\s*&\s*TV\s+Shows[^0-9]{0,100}([0-9]+\.[0-9]+\.5[0-9]{3,})\s+(?:XAPK\s+APKs|XAPK|APK\s+Bundle|APK|APKs)\b/gi;
      let match;
      while ((match = pattern.exec(compact))) {
        const version = this.cleanVersion(match[1]);
        if (!this.isUsableVersion(version)) continue;
        const key = `${version}:${target.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(this.candidate({
          source: 'apkfab-version-url',
          version,
          version_code: '',
          updated: this.updatedFromText(compact.slice(Math.max(0, match.index - 200), match.index + 400)),
          url: target.url,
          usable: true,
          tv_confirmed: true,
          confidence: Math.min(target.confidence, 0.83),
          tv_evidence: 'APKFab Tubi controlled fallback: accepted only the x.y.5xxx TV-style branch and ignored generic/mobile x.y.z rows.',
          note: `Parsed APKFab Tubi flattened version-history text via ${target.method}.`,
        }));
      }
    }

    return this.uniqueBy(out, c => `${c.source}:${c.version}:${c.url}`);
  }

  apkFabTitleHasTvEvidence(plain, normalised, meta = {}) {
    const head = String(plain || '').split(/\r?\n/).slice(0, 80).join(' ');
    if (ANDROID_TV_RE.test(`${normalised.source_url} ${normalised.app_slug || ''}`)) return true;
    if (ANDROID_TV_RE.test(head) && this.importantTokens(meta.title || normalised.app_slug || '').some(t => head.toLowerCase().includes(t))) return true;
    return false;
  }


  async lookupAptoideSource(normalised, meta = {}, packageName = '') {
    const sourceUrl = normalised.source_url;
    const targets = [
      { method: 'direct-source-url', url: sourceUrl, confidence: 0.84, kind: 'html', timeout: 5000 },
      { method: 'jina-reader-source-url', url: `https://r.jina.ai/${sourceUrl}`, confidence: 0.82, kind: 'reader', timeout: 5000 },
    ];

    if (normalised.versions_url && normalised.versions_url !== sourceUrl) {
      targets.push({ method: 'direct-derived-versions-url', url: normalised.versions_url, confidence: 0.83, kind: 'html', timeout: 5000 });
      targets.push({ method: 'jina-reader-derived-versions-url', url: `https://r.jina.ai/${normalised.versions_url}`, confidence: 0.81, kind: 'reader', timeout: 5000 });
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
        const parsed = this.extractAptoideCandidates(text, normalised, target, meta, packageName);
        if (parsed.length) { out.push(...parsed); return out; }
        out.push(this.candidate({ source: 'aptoide-version-url', url: target.url, error: `${target.method}: fetched but no usable Aptoide version parsed` }));
      } catch (error) {
        out.push(this.candidate({ source: 'aptoide-version-url', url: target.url, error: `${target.method}: ${error.message || 'fetch failed'}` }));
      }
    }
    return out;
  }

  extractAptoideCandidates(text, normalised, target, meta = {}, packageName = '') {
    const raw = String(text || '');
    const plain = this.toPlainText(raw);
    const compact = plain.replace(/\s+/g, ' ').trim();
    const out = [];
    const seen = new Set();
    const pkg = String(packageName || '').trim().toLowerCase();
    const sourcePkg = String(normalised.package_from_path || '').trim().toLowerCase();
    const rule = this.knownPackageBranchRule(pkg);

    if (pkg && sourcePkg && pkg !== sourcePkg) return out;

    const trustedTvPage = Boolean(normalised.source_has_tv_hint || this.aptoideTitleHasTvEvidence(plain, normalised, meta));
    const packageBranchAllowed = Boolean(rule && rule.allowAptoide !== false && (!rule.titlePattern || rule.titlePattern.test(`${plain} ${normalised.app_slug || ''}`)));

    if (!trustedTvPage && !packageBranchAllowed) return out;

    const lines = plain.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const match = line.match(/\b([0-9]+(?:\.[0-9]+){1,5}(?:[-+](?:rc|beta|alpha)\d*)?)\b/i);
      if (!match) continue;
      const version = this.cleanVersion(match[1]);
      if (!this.isUsableVersion(version)) continue;
      const context = [lines[i - 3] || '', lines[i - 2] || '', lines[i - 1] || '', line, lines[i + 1] || '', lines[i + 2] || '', lines[i + 3] || '', lines[i + 4] || '', lines[i + 5] || ''].join(' ');
      if (this.isFireTvContext(context)) continue;

      let accept = false;
      let evidence = '';
      let confidence = target.confidence;
      if (packageBranchAllowed && rule.acceptVersion(version)) {
        accept = true;
        confidence = Math.min(target.confidence, 0.82);
        evidence = rule.evidence.replace(/APKPure\/APKFab/i, 'APKPure/APKFab/Aptoide');
      } else if (trustedTvPage && this.isConfirmedAndroidTvContext(`${normalised.source_url} ${context}`)) {
        accept = true;
        evidence = `Aptoide source page is TV-scoped and exposes a version-history row (${target.method}).`;
      }
      if (!accept) continue;

      const key = `${version}:${target.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.candidate({
        source: 'aptoide-version-url',
        version,
        version_code: '',
        updated: this.updatedFromText(context),
        url: target.url,
        usable: true,
        tv_confirmed: true,
        confidence,
        tv_evidence: evidence,
        note: packageBranchAllowed
          ? `Parsed latest ${rule.fallbackKind} version from Aptoide via ${target.method}; no Android TV text required for this package-specific ${rule.branchLabel} rule.`
          : `Parsed Aptoide TV-scoped version-history row via ${target.method}.`,
      }));
      if (rule?.pickFirstVisible && out.length) return [out[0]];
    }

    if (packageBranchAllowed) {
      const versionPattern = /\b([0-9]+(?:\.[0-9]+){1,5}(?:[-+](?:rc|beta|alpha)\d*)?)\b/g;
      let match;
      while ((match = versionPattern.exec(compact))) {
        const version = this.cleanVersion(match[1]);
        if (!this.isUsableVersion(version) || !rule.acceptVersion(version)) continue;
        const around = compact.slice(Math.max(0, match.index - 220), match.index + 420);
        if (this.isFireTvContext(around)) continue;
        const key = `${version}:${target.url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(this.candidate({
          source: 'aptoide-version-url',
          version,
          version_code: '',
          updated: this.updatedFromText(around),
          url: target.url,
          usable: true,
          tv_confirmed: true,
          confidence: Math.min(target.confidence, 0.82),
          tv_evidence: rule.evidence.replace(/APKPure\/APKFab/i, 'APKPure/APKFab/Aptoide'),
          note: `Parsed latest ${rule.fallbackKind} version from flattened Aptoide text via ${target.method}; no Android TV text required for this package-specific ${rule.branchLabel} rule.`,
        }));
        if (rule.pickFirstVisible && out.length) return [out[0]];
      }
    }

    return this.uniqueBy(out, c => `${c.source}:${c.version}:${c.url}`);
  }

  aptoideTitleHasTvEvidence(plain, normalised, meta = {}) {
    const head = String(plain || '').split(/\r?\n/).slice(0, 100).join(' ');
    if (ANDROID_TV_RE.test(`${normalised.source_url} ${normalised.app_slug || ''}`)) return true;
    if (ANDROID_TV_RE.test(head) && this.importantTokens(meta.title || normalised.app_slug || '').some(t => head.toLowerCase().includes(t))) return true;
    return false;
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

    if (target.kind === 'search') {
      return this.extractSearchResultCandidates(body, normalised, target, meta);
    }

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
      if (this.isLikelyRatingVersion(info.version, chunk)) continue;
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


  candidateFromExactApkMirrorSourceUrl(normalised) {
    if (!normalised || normalised.source_type !== 'apkmirror') return null;
    if (!normalised.is_release_url || !normalised.source_has_tv_hint) return null;
    if (this.isFireTvContext(normalised.source_url)) return null;
    const info = this.versionFromReleaseSlug(normalised.release_slug, normalised.app_slug || '');
    if (!this.isUsableVersion(info.version)) return null;
    return this.candidate({
      source: 'apkmirror-source-url',
      version: info.version,
      version_code: info.version_code || '',
      updated: '',
      url: normalised.source_url,
      usable: true,
      tv_confirmed: true,
      confidence: 0.99,
      tv_evidence: 'The supplied APKMirror source URL is an exact Android TV release URL, so the version was parsed from the URL slug without fetching the blocked page.',
      note: 'Parsed exact APKMirror Android TV release URL without page fetch.',
    });
  }

  sameAppApkMirrorVariantTargets(normalised) {
    // APKMirror's plain app listing can be very thin via 403/Jina, while the same-app
    // variant filter pages often expose the actual Android TV rows. This is still
    // bounded to the supplied developer/app slug; it does not search APKMirror globally
    // and it does not relax the final Android TV / Fire TV checks.
    if (!normalised || normalised.source_type !== 'apkmirror') return [];
    if (normalised.kind !== 'app' || !normalised.developer_slug || !normalised.app_slug) return [];
    if (!normalised.source_has_tv_hint || this.isFireTvContext(normalised.source_url)) return [];

    const base = `https://www.apkmirror.com/apk/${normalised.developer_slug}/${normalised.app_slug}`;
    const variants = [
      // Common Android TV universal/dual-arch listing. This is the one used by many
      // TV apps, including Tubi's Android TV page.
      'variant-%7B%22arches_slug%22%3A%5B%22arm64-v8a%22%2C%22armeabi-v7a%22%5D%7D/',
      // Some APKMirror app pages expose useful rows by DPI or min API instead of arch.
      'variant-%7B%22dpis_slug%22%3A%5B%22320%22%5D%7D/',
      'variant-%7B%22minapi_slug%22%3A%22minapi-28%22%7D/',
    ];

    return variants.slice(0, 1).flatMap((variant, index) => {
      const url = `${base}/${variant}`;
      const confidence = 0.94 - (index * 0.01);
      return [
        { method: `direct-same-app-variant-${index + 1}`, url, confidence, kind: 'html', timeout: 3000 },
        { method: `jina-reader-same-app-variant-${index + 1}`, url: `https://r.jina.ai/${url}`, confidence: Math.max(0.88, confidence - 0.02), kind: 'reader', timeout: 5000 },
      ];
    });
  }



  sameDeveloperApkMirrorTargets(normalised) {
    // Some APKMirror app pages (notably Android-TV-specific listing pages) are blocked
    // from Render by security verification, while the developer page remains fetchable
    // and lists the same Android TV upload next to the generic/mobile uploads. This
    // target stays on the same developer slug only, and the normal parser still requires
    // nearby Android TV evidence and rejects Fire TV/generic rows before selection.
    if (!normalised || normalised.source_type !== 'apkmirror') return [];
    if (!normalised.developer_slug) return [];
    if (normalised.kind === 'developer') return [];
    if (this.isFireTvContext(normalised.source_url)) return [];

    const url = `https://www.apkmirror.com/apk/${normalised.developer_slug}/`;
    return [
      { method: 'direct-same-developer-page', url, confidence: 0.92, kind: 'html', timeout: 3500 },
      { method: 'jina-reader-same-developer-page', url: `https://r.jina.ai/${url}`, confidence: 0.90, kind: 'reader', timeout: 5000 },
    ];
  }

  knownPackageBranchRule(packageName = '') {
    const pkg = String(packageName || '').trim().toLowerCase();
    const rules = {
      'com.tubitv': {
        name: 'Tubi',
        titlePattern: /\bTubi\b/i,
        acceptVersion: version => /^[0-9]+\.[0-9]+\.5[0-9]{3,}$/.test(version),
        branchLabel: 'x.y.5xxx',
        fallbackKind: 'Tubi TV branch',
        evidence: 'Tubi-specific APKPure fallback: APKPure/APKFab do not label this history as Android TV, so the checker accepted only the Tubi TV branch pattern x.y.5xxx and ignored generic/mobile x.y.z rows.',
        urls: [
          { url: 'https://apkpure.com/tubi-movies-tv-shows-android-app/com.tubitv/versions', method: 'apkpure-tubi-tv-branch-versions', confidence: 0.81, timeout: 3500 },
          { url: 'https://r.jina.ai/https://apkpure.com/tubi-movies-tv-shows-android-app/com.tubitv/versions', method: 'jina-reader-apkpure-tubi-tv-branch-versions', confidence: 0.805, timeout: 4500 },
          { url: 'https://apkpure.net/tubi-movies-tv-shows-android-app/com.tubitv/versions', method: 'apkpure-net-tubi-tv-branch-versions', confidence: 0.80, timeout: 3500 },
          { url: 'https://apkpure.com/howto/how-to-download-tubi-movies-tv-shows-old-version-on-android', method: 'apkpure-tubi-old-version-article', confidence: 0.79, timeout: 4000 },
          { url: 'https://r.jina.ai/https://apkpure.com/howto/how-to-download-tubi-movies-tv-shows-old-version-on-android', method: 'jina-reader-apkpure-tubi-old-version-article', confidence: 0.785, timeout: 4500 },
          { url: 'https://www.bing.com/search?q=' + encodeURIComponent('site:apkpure.com/tubi-movies-tv-shows-android-app/com.tubitv/versions "Tubi TV" "XAPK" "MB"') + '&format=rss', method: 'bing-rss-apkpure-tubi-versions-index', confidence: 0.77, timeout: 3500 },
        ],
        allowApkMirrorBootstrap: normalised => normalised?.source_type === 'apkmirror' && (normalised.developer_slug === 'tubi-tv' || normalised.source_has_tv_hint),
        pickFirstVisible: false,
      },
      'io.odeum.learntaichi': {
        name: 'Tai Chi at Home',
        titlePattern: /\bTai\s+Chi\s+at\s+Home\b/i,
        acceptVersion: version => /^1\.[0-9]+\.[0-9]+$/.test(version),
        branchLabel: '1.x.x',
        fallbackKind: 'Tai Chi at Home TV branch',
        evidence: 'Tai Chi at Home-specific package fallback: the source lists the TV-style 1.x.x branch alongside unrelated/newer 3.x.x rows, so the checker accepted only the latest 1.x.x branch version and ignored 3.x.x rows.',
        urls: [
          { url: 'https://tai-chi-at-home.en.aptoide.com/versions', method: 'aptoide-taichi-tv-branch-versions', confidence: 0.82, timeout: 5000 },
          { url: 'https://r.jina.ai/https://tai-chi-at-home.en.aptoide.com/versions', method: 'jina-reader-aptoide-taichi-tv-branch-versions', confidence: 0.81, timeout: 5000 },
          { url: 'https://apkpure.com/tai-chi-at-home/io.odeum.learntaichi/download', method: 'apkpure-taichi-tv-branch-download', confidence: 0.81, timeout: 4000 },
          { url: 'https://r.jina.ai/https://apkpure.com/tai-chi-at-home/io.odeum.learntaichi/download', method: 'jina-reader-apkpure-taichi-tv-branch-download', confidence: 0.805, timeout: 4500 },
          { url: 'https://apkpure.com/tai-chi-at-home/io.odeum.learntaichi/versions', method: 'apkpure-taichi-tv-branch-versions', confidence: 0.80, timeout: 3500 },
          { url: 'https://apkpure.net/tai-chi-at-home/io.odeum.learntaichi/versions', method: 'apkpure-net-taichi-tv-branch-versions', confidence: 0.79, timeout: 3500 },
        ],
        allowApkMirrorBootstrap: () => false,
        pickFirstVisible: false,
        allowAptoide: true,
      },
      'com.apple.atve.androidtv.appletv': {
        name: 'Apple TV',
        titlePattern: /\bApple\s+TV\b/i,
        acceptVersion: version => /^1[0-9]\.[0-9]+\.[0-9]+$/.test(version),
        branchLabel: '1x.x.x',
        fallbackKind: 'Apple TV Android TV branch',
        evidence: 'Apple TV-specific package fallback: Apple mobile and Android TV builds can appear under related app names, so the checker accepted only the 1x.x.x Android TV branch and ignored mobile 2.x.x rows.',
        urls: [
          { url: 'https://apkpure.com/apple-tv/com.apple.atve.androidtv.appletv/versions', method: 'apkpure-apple-tv-androidtv-branch-versions', confidence: 0.82, timeout: 3500 },
          { url: 'https://r.jina.ai/https://apkpure.com/apple-tv/com.apple.atve.androidtv.appletv/versions', method: 'jina-reader-apkpure-apple-tv-androidtv-branch-versions', confidence: 0.815, timeout: 4500 },
          { url: 'https://apkpure.com/apple-tv/com.apple.atve.androidtv.appletv/download', method: 'apkpure-apple-tv-androidtv-branch-download', confidence: 0.81, timeout: 3500 },
          { url: 'https://r.jina.ai/https://apkpure.com/apple-tv/com.apple.atve.androidtv.appletv/download', method: 'jina-reader-apkpure-apple-tv-androidtv-branch-download', confidence: 0.805, timeout: 4500 },
          { url: 'https://www.apkmirror.com/apk/apple/apple-tv-android-tv-2/', method: 'apkmirror-apple-tv-androidtv-branch-listing', confidence: 0.80, timeout: 3500 },
          { url: 'https://r.jina.ai/https://www.apkmirror.com/apk/apple/apple-tv-android-tv-2/', method: 'jina-reader-apkmirror-apple-tv-androidtv-branch-listing', confidence: 0.795, timeout: 4500 },
        ],
        allowApkMirrorBootstrap: normalised => normalised?.source_type === 'apkmirror' && normalised.developer_slug === 'apple',
        pickFirstVisible: false,
        allowAptoide: true,
      },
      'uk.gbnews.app': {
        name: 'GB News',
        titlePattern: /\bGB\s+News\b/i,
        acceptVersion: version => /^1\.[0-9]+$/.test(version),
        branchLabel: '1.x',
        fallbackKind: 'GB News TV branch',
        evidence: 'GB News-specific package fallback: the source does not separate the TV app from the mobile app, so the checker accepted only the 1.x TV-style branch and ignored mobile 2.x.x rows.',
        urls: [
          { url: 'https://apkpure.com/gb-news/uk.gbnews.app/versions', method: 'apkpure-gbnews-tv-branch-versions', confidence: 0.81, timeout: 3500 },
          { url: 'https://r.jina.ai/https://apkpure.com/gb-news/uk.gbnews.app/versions', method: 'jina-reader-apkpure-gbnews-tv-branch-versions', confidence: 0.805, timeout: 4500 },
          { url: 'https://apkpure.net/gb-news/uk.gbnews.app/versions', method: 'apkpure-net-gbnews-tv-branch-versions', confidence: 0.80, timeout: 3500 },
          { url: 'https://gb-news-gb-news.en.aptoide.com/versions', method: 'aptoide-gbnews-tv-branch-versions', confidence: 0.82, timeout: 5000 },
          { url: 'https://r.jina.ai/https://gb-news-gb-news.en.aptoide.com/versions', method: 'jina-reader-aptoide-gbnews-tv-branch-versions', confidence: 0.81, timeout: 5000 },
          { url: 'https://www.bing.com/search?q=' + encodeURIComponent('site:apkpure.com/gb-news/uk.gbnews.app/versions "GB News 1." "MB"') + '&format=rss', method: 'bing-rss-apkpure-gbnews-versions-index', confidence: 0.77, timeout: 3500 },
        ],
        allowApkMirrorBootstrap: () => false,
        // APKPure lists GB News old versions newest-first. Because legacy versions like 1.12
        // are numerically higher than the newer TV branch version 1.8, return the first visible
        // matching 1.x row rather than sorting all 1.x rows semantically.
        pickFirstVisible: true,
        allowAptoide: true,
      },
    };
    return rules[pkg] || null;
  }

  samePackageApkPureFallbackTargets(normalised, packageName = '') {
    // Controlled per-package fallbacks for apps where APKPure lists TV and mobile versions
    // under the same package/app name without Android TV labels. These do NOT search for
    // Android TV text. Instead each package has a conservative version-branch rule.
    const pkg = String(packageName || '').trim().toLowerCase();
    const rule = this.knownPackageBranchRule(pkg);
    if (!rule) return [];
    if (!normalised || this.isFireTvContext(normalised.source_url)) return [];

    const sourceMatchesPackage = normalised.source_type === 'apkpure'
      && (normalised.package_from_path === pkg || normalised.source_url.toLowerCase().includes(pkg));
    const apkMirrorBootstrapAllowed = typeof rule.allowApkMirrorBootstrap === 'function' && rule.allowApkMirrorBootstrap(normalised);
    if (!sourceMatchesPackage && !apkMirrorBootstrapAllowed) return [];

    const urls = [];
    if (sourceMatchesPackage) {
      const supplied = normalised.source_url;
      const suppliedVersions = /\/versions\/?(?:$|[?#])/i.test(supplied)
        ? supplied
        : supplied.replace(/\/?(?:[?#].*)?$/, '/versions');
      urls.push({ url: suppliedVersions, method: `apkpure-${pkg}-supplied-or-derived-versions`, confidence: 0.82, timeout: 3500 });
      if (normalised.alternate_url) {
        const alternateVersions = /\/versions\/?(?:$|[?#])/i.test(normalised.alternate_url)
          ? normalised.alternate_url
          : normalised.alternate_url.replace(/\/?(?:[?#].*)?$/, '/versions');
        urls.push({ url: alternateVersions, method: `apkpure-${pkg}-alternate-derived-versions`, confidence: 0.80, timeout: 3500 });
      }
    }
    urls.push(...rule.urls);

    return this.uniqueBy(urls, item => item.url).map(item => ({
      method: item.method,
      source: 'apkpure-package-versions-fallback',
      url: item.url,
      confidence: item.confidence,
      kind: 'apkpure-tv-branch',
      timeout: item.timeout || 3500,
    }));
  }

  extractKnownTvBranchApkPureFallbackCandidates(text, normalised, target, packageName = '') {
    const pkg = String(packageName || '').trim().toLowerCase();
    const rule = this.knownPackageBranchRule(pkg);
    if (!rule) return [];
    if (!normalised || this.isFireTvContext(normalised.source_url)) return [];

    const sourceMatchesPackage = normalised.source_type === 'apkpure'
      && (normalised.package_from_path === pkg || normalised.source_url.toLowerCase().includes(pkg));
    const apkMirrorBootstrapAllowed = typeof rule.allowApkMirrorBootstrap === 'function' && rule.allowApkMirrorBootstrap(normalised);
    if (!sourceMatchesPackage && !apkMirrorBootstrapAllowed) return [];

    const raw = String(text || '');
    const plain = this.toPlainText(raw).replace(/\s+/g, ' ').trim();
    if (rule.titlePattern && !rule.titlePattern.test(plain)) return [];

    const out = [];
    const seen = new Set();
    const escapedName = String(rule.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const versionPattern = '([0-9]+(?:\\.[0-9]+){1,5}(?:[-+](?:rc|beta|alpha)\\d*)?)';
    const patterns = [
      // Normal APKPure versions page/search snippets: "GB News 1.8 14.4 MB Feb 4, 2026".
      new RegExp(`${escapedName}[^0-9]{0,120}${versionPattern}(?:\\s+([0-9]+(?:\\.[0-9]+)?\\s*MB))?(?:\\s+([A-Za-z]{3,9}\\s+\\d{1,2},\\s+20\\d{2}))?`, 'gi'),
      // Flattened tables can show just version, size, date once the app title has been established.
      /\b([0-9]+(?:\.[0-9]+){1,5}(?:[-+](?:rc|beta|alpha)\d*)?)\b\s*,?\s*([0-9]+(?:\.[0-9]+)?\s*MB)?\s*,?\s*([A-Za-z]{3,9}\s+\d{1,2},\s+20\d{2})?/gi,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(plain))) {
        const version = this.cleanVersion(match[1]);
        if (!this.isUsableVersion(version)) continue;
        if (!rule.acceptVersion(version)) continue;
        const sizeText = match[2] || '';
        const dateText = match[3] || '';
        const key = version;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(this.candidate({
          source: 'apkpure-package-versions-fallback',
          version,
          version_code: '',
          updated: dateText,
          url: this.apkpureDownloadUrlForPackage(pkg, version),
          usable: true,
          tv_confirmed: true,
          confidence: target.confidence,
          tv_evidence: rule.evidence + (sizeText ? ' (' + sizeText + ')' : ''),
          note: `Parsed latest ${rule.fallbackKind} version from APKPure/index text via ${target.method}; no Android TV text required for this package-specific ${rule.branchLabel} rule.`,
        }));
        if (rule.pickFirstVisible && out.length) {
          return [out[0]];
        }
      }
    }

    return rule.pickFirstVisible && out.length ? [out[0]] : this.uniqueBy(out, c => c.source + ':' + c.version + ':' + c.url);
  }

  apkpureDownloadUrlForPackage(packageName = '', version = '') {
    const pkg = String(packageName || '').trim().toLowerCase();
    const encodedVersion = encodeURIComponent(String(version || '').trim());
    if (pkg === 'com.tubitv') return 'https://apkpure.com/tubi-movies-tv-shows-android-app/com.tubitv/download/' + encodedVersion;
    if (pkg === 'uk.gbnews.app') return 'https://apkpure.com/gb-news/uk.gbnews.app/download/' + encodedVersion;
    if (pkg === 'io.odeum.learntaichi') return 'https://apkpure.com/tai-chi-at-home/io.odeum.learntaichi/download/' + encodedVersion;
    if (pkg === 'com.apple.atve.androidtv.appletv') return 'https://apkpure.com/apple-tv/com.apple.atve.androidtv.appletv/download/' + encodedVersion;
    return '';
  }

  sameAppPublicSearchTargets(normalised, meta = {}) {
    // Disabled in 1.4.7 because general search pages can hang long enough for the 20i -> Render
    // request to hit the 45 second outer timeout. Use bounded package/version pages instead.
    return [];
    // When APKMirror blocks direct/reader access with its bot verification page,
    // use normal public search-result pages as a last resort. This is still tightly
    // scoped to the supplied APKMirror developer/app slug and the parser still requires
    // Android TV evidence before accepting any version. No API key is required.
    if (!normalised || normalised.source_type !== 'apkmirror') return [];
    if (!normalised.developer_slug || !normalised.app_slug) return [];
    if (!normalised.source_has_tv_hint || this.isFireTvContext(normalised.source_url)) return [];
    if (!(normalised.kind === 'app' || normalised.kind === 'release' || normalised.kind === 'variant')) return [];

    const title = this.searchSafeTitle(meta.title || normalised.app_slug.replace(/-/g, ' '));
    const appSlugs = [normalised.app_slug];
    // APKMirror often has both a generic app listing and an Android-TV-specific app listing.
    // For pages like /tubi-free-movies-live-tv-android-tv/, the generic sibling page is
    // sometimes the page indexed by public search. We only use this for search snippets,
    // and the final parser still requires nearby Android TV evidence, so generic/mobile
    // rows are not accepted just because the sibling page is searched.
    if (/-android-tv$/i.test(normalised.app_slug)) {
      appSlugs.push(normalised.app_slug.replace(/-android-tv$/i, ''));
    }

    const queries = [];
    for (const appSlug of this.uniqueBy(appSlugs, v => v)) {
      const scopedPath = `site:apkmirror.com/apk/${normalised.developer_slug}/${appSlug}`;
      queries.push([scopedPath, title ? `"${title}"` : '', '"Android TV"', 'APKMirror'].filter(Boolean).join(' '));
      queries.push([scopedPath, '"Android TV"', '"Version:"', 'APKMirror'].filter(Boolean).join(' '));
      queries.push([scopedPath, `${normalised.app_slug}-`, 'release', '"Android TV"'].filter(Boolean).join(' '));
    }

    const enginesForQuery = (query, qIndex) => {
      const encoded = encodeURIComponent(query);
      const rankPenalty = qIndex * 0.015;
      return [
        { method: `bing-rss-same-app-android-tv-${qIndex + 1}`, url: `https://www.bing.com/search?q=${encoded}&format=rss`, confidence: 0.855 - rankPenalty, kind: 'search', timeout: 15000 },
        { method: `duckduckgo-lite-same-app-android-tv-${qIndex + 1}`, url: `https://lite.duckduckgo.com/lite/?q=${encoded}`, confidence: 0.845 - rankPenalty, kind: 'search', timeout: 15000 },
        { method: `duckduckgo-html-same-app-android-tv-${qIndex + 1}`, url: `https://html.duckduckgo.com/html/?q=${encoded}`, confidence: 0.835 - rankPenalty, kind: 'search', timeout: 15000 },
        { method: `bing-html-same-app-android-tv-${qIndex + 1}`, url: `https://www.bing.com/search?q=${encoded}`, confidence: 0.825 - rankPenalty, kind: 'search', timeout: 15000 },
        { method: `jina-reader-bing-same-app-android-tv-${qIndex + 1}`, url: `https://r.jina.ai/https://www.bing.com/search?q=${encoded}`, confidence: 0.815 - rankPenalty, kind: 'search', timeout: 15000 },
      ];
    };

    // Keep this bounded: at most the first four focused queries, and stop in the
    // caller as soon as any confirmed Android TV candidate is found.
    return this.uniqueBy(queries, q => q).slice(0, 4).flatMap(enginesForQuery);
  }

  extractSearchResultCandidates(text, normalised, target, meta = {}) {
    const expanded = this.decodeSearchResultText(text);
    const expandedLinks = expanded.replace(/href=([\"'])([^\"']+)\1/gi, (full, quote, href) => full + ' ' + href + ' ');
    const plain = this.toPlainText(expanded).replace(/\s+/g, ' ').trim();
    const out = [];
    const seen = new Set();

    for (const item of this.extractReleaseUrls(expandedLinks, normalised)) {
      const combined = `${item.absolute_url} ${item.app_slug} ${item.release_slug} ${item.raw}`;
      if (!this.isConfirmedAndroidTvContext(combined)) continue;
      if (this.isFireTvContext(combined)) continue;
      if (!this.sourceScopeAllowsRelease(item, normalised, meta)) continue;

      const info = this.versionFromReleaseSlug(item.release_slug, item.app_slug);
      if (!this.isUsableVersion(info.version)) continue;
      const key = `url:${info.version}:${info.version_code || ''}:${item.absolute_url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.candidate({
        source: 'apkmirror-source-url',
        version: info.version,
        version_code: info.version_code || '',
        updated: this.updatedFromText(plain),
        url: item.absolute_url,
        usable: true,
        tv_confirmed: true,
        confidence: target.confidence,
        tv_evidence: `Public search result contains a same-app APKMirror Android TV release URL (${target.method}).`,
        note: `Parsed APKMirror Android TV version from public search result via ${target.method}.`,
      }));
    }

    // Some search result pages expose the APKMirror title/snippet but hide the URL behind
    // redirect parameters. Accept only same-app, Android TV adjacent title/snippet text.
    const chunks = plain
      .split(/(?:\r?\n|(?=Download\s)|(?=APKMirror\s)|(?=https?:\/\/www\.apkmirror\.com)|(?=Result\s)|(?=Version:)|(?=Uploaded:)|(?=File size:))/i)
      .map(v => v.trim())
      .filter(Boolean);
    const candidatesToCheck = chunks.length ? chunks : [plain];
    for (const chunk of candidatesToCheck) {
      if (!this.isConfirmedAndroidTvContext(chunk)) continue;
      if (this.isFireTvContext(chunk)) continue;
      if (this.isApkMirrorNoiseChunk(chunk)) continue;
      if (!this.textScopeAllowsChunk(chunk, normalised, meta)) continue;
      const info = this.versionFromAndroidTvLine(chunk);
      if (!this.isUsableVersion(info.version)) continue;
      if (this.isLikelyRatingVersion(info.version, chunk)) continue;
      const key = `text:${info.version}:${info.version_code || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.candidate({
        source: 'apkmirror-source-url',
        version: info.version,
        version_code: info.version_code || '',
        updated: this.updatedFromText(chunk),
        url: normalised.source_url,
        usable: true,
        tv_confirmed: true,
        confidence: Math.min(target.confidence, 0.80),
        tv_evidence: `Public search result title/snippet contains same-app Android TV and a semantic version (${target.method}).`,
        note: `Parsed APKMirror Android TV version from public search text via ${target.method}.`,
      }));
    }

    // Search pages sometimes show only the release slug/path text rather than a clean link,
    // especially in RSS snippets or redirect-heavy result pages. Parse that only when it is
    // the same Android-TV app slug and Android TV evidence is nearby.
    for (const item of this.extractSameAppReleaseSlugMentions(expandedLinks + ' ' + plain, normalised)) {
      const combined = `${item.release_slug} ${item.context}`;
      if (!this.isConfirmedAndroidTvContext(combined)) continue;
      if (this.isFireTvContext(combined)) continue;
      const info = this.versionFromReleaseSlug(item.release_slug, normalised.app_slug);
      if (!this.isUsableVersion(info.version)) continue;
      const key = `slug:${info.version}:${info.version_code || ''}:${item.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(this.candidate({
        source: 'apkmirror-source-url',
        version: info.version,
        version_code: info.version_code || '',
        updated: this.updatedFromText(item.context),
        url: item.url,
        usable: true,
        tv_confirmed: true,
        confidence: Math.min(target.confidence, 0.81),
        tv_evidence: `Public search result contains the same-app Android TV APKMirror release slug (${target.method}).`,
        note: `Parsed APKMirror Android TV release slug from public search text via ${target.method}.`,
      }));
    }

    return this.uniqueBy(out, c => `${c.version}:${c.version_code}:${c.url}`);
  }

  decodeSearchResultText(text) {
    let out = this.decodeHtml(String(text || ''));
    const safeDecode = value => {
      try { return decodeURIComponent(String(value || '').replace(/\+/g, ' ')); } catch (_) { return String(value || ''); }
    };
    const decodeBingUrlParam = value => {
      const raw = String(value || '');
      const decoded = safeDecode(raw);
      const maybe = decoded.startsWith('a1') ? decoded.slice(2) : decoded;
      if (!/^[A-Za-z0-9_-]{20,}={0,2}$/.test(maybe)) return decoded;
      try {
        const padded = maybe.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(maybe.length / 4) * 4, '=');
        const asText = Buffer.from(padded, 'base64').toString('utf8');
        return /^https?:\/\//i.test(asText) ? asText : decoded;
      } catch (_) {
        return decoded;
      }
    };
    const decodeUrlParam = encoded => {
      const decoded = safeDecode(encoded);
      const bingDecoded = decodeBingUrlParam(decoded);
      return /^https?:\/\//i.test(bingDecoded) ? bingDecoded : decoded;
    };
    for (let i = 0; i < 4; i += 1) {
      out = out.replace(/(?:uddg|u|url|q)=([^&"'<>\s]+)/gi, (_, encoded) => decodeUrlParam(encoded));
      out = out.replace(/https%3A%2F%2Fwww\.apkmirror\.com[^"'<>\s&]*/gi, match => safeDecode(match));
      out = out.replace(/https%253A%252F%252Fwww\.apkmirror\.com[^"'<>\s&]*/gi, match => safeDecode(safeDecode(match)));
      out = this.decodeHtml(out);
    }
    return out;
  }

  extractSameAppReleaseSlugMentions(text, normalised) {
    const out = [];
    if (!normalised || !normalised.app_slug || !normalised.developer_slug) return out;
    const app = this.escapeRegex(normalised.app_slug);
    const pattern = new RegExp(`${app}-(\\d+(?:[-.]\\d+){1,5}(?:(?:rc|beta|alpha)\\d*)?)-release`, 'gi');
    let match;
    const source = String(text || '');
    while ((match = pattern.exec(source))) {
      const releaseSlug = `${normalised.app_slug}-${String(match[1]).replace(/\./g, '-')}-release`;
      const context = this.contextAround(source, match[0], 500) || match[0];
      out.push({
        release_slug: releaseSlug,
        context,
        url: `https://www.apkmirror.com/apk/${normalised.developer_slug}/${normalised.app_slug}/${releaseSlug}/`,
      });
    }
    return this.uniqueBy(out, item => item.url);
  }

  escapeRegex(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  searchSafeTitle(value) {
    return String(value || '')
      .replace(/["<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90);
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
    if (APKFAB_HOST_RE.test(url.hostname)) return this.normaliseApkFabSourceUrl(raw);
    if (APTOIDE_HOST_RE.test(url.hostname)) return this.normaliseAptoideSourceUrl(raw);
    throw new Error('Version source URL must be on apkmirror.com, apkpure.com, apkpure.net, apkfab.com, or aptoide.com.');
  }


  normaliseAptoideSourceUrl(input) {
    const raw = String(input || '').trim();
    let url;
    try { url = new URL(raw); } catch (_) { throw new Error('Aptoide source URL is not a valid URL.'); }
    if (!APTOIDE_HOST_RE.test(url.hostname)) throw new Error('Aptoide source URL must be on aptoide.com.');
    const sourceUrl = `https://${url.hostname}${url.pathname}${url.search || ''}`;
    const parts = url.pathname.split('/').filter(Boolean);
    const packageFromPath = parts.find(part => /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/i.test(part)) || '';
    const hostPrefix = url.hostname.replace(/\.(?:[a-z]{2}\.)?aptoide\.com$/i, '').replace(/\.(?:en|gb|us)$/i, '');
    const appSlug = (parts[0] && !/^versions$/i.test(parts[0])) ? parts[0] : (hostPrefix || '');
    let versionsUrl = sourceUrl;
    if (!/\/versions\/?$/i.test(url.pathname)) {
      const basePath = parts.length ? '/' + parts.join('/') : '';
      versionsUrl = `https://${url.hostname}${basePath.replace(/\/$/, '')}/versions`;
    }
    return {
      source_type: 'aptoide',
      kind: /\/versions\/?$/i.test(url.pathname) ? 'aptoide-versions' : 'aptoide',
      source_url: sourceUrl,
      versions_url: versionsUrl,
      alternate_url: '',
      developer_slug: '',
      app_slug: appSlug,
      release_slug: '',
      package_from_path: packageFromPath,
      original_url: raw,
      is_variant_url: false,
      is_release_url: false,
      source_has_tv_hint: /android[-\s]*tv|leanback|google[-\s]*tv|aptoide[-\s]*tv/i.test(`${sourceUrl} ${appSlug}`),
    };
  }

  normaliseApkFabSourceUrl(input) {
    const raw = String(input || '').trim();
    let url;
    try { url = new URL(raw); } catch (_) { throw new Error('APKFab source URL is not a valid URL.'); }
    if (!APKFAB_HOST_RE.test(url.hostname)) throw new Error('APKFab source URL must be on apkfab.com.');
    const parts = url.pathname.split('/').filter(Boolean);
    const packageFromPath = parts.find(part => /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/i.test(part)) || '';
    const packageIndex = packageFromPath ? parts.indexOf(packageFromPath) : -1;
    const appSlug = packageIndex > 0 ? parts[packageIndex - 1] : (parts[0] || '');
    const cleanPath = '/' + parts.join('/') + (url.pathname.endsWith('/') ? '/' : '');
    const sourceUrl = `https://apkfab.com${cleanPath}${url.search || ''}`;
    let versionsUrl = sourceUrl;
    if (packageFromPath && !/\/versions\/?$/i.test(url.pathname)) {
      versionsUrl = `https://apkfab.com/${parts.slice(0, packageIndex + 1).join('/')}/versions`;
    }
    return {
      source_type: 'apkfab',
      kind: /\/versions\/?$/i.test(url.pathname) ? 'apkfab-versions' : 'apkfab',
      source_url: sourceUrl,
      versions_url: versionsUrl,
      alternate_url: '',
      developer_slug: '',
      app_slug: appSlug,
      release_slug: '',
      package_from_path: packageFromPath,
      original_url: raw,
      is_variant_url: false,
      is_release_url: false,
      source_has_tv_hint: /android[-\s]*tv|leanback|google[-\s]*tv/i.test(`${sourceUrl} ${appSlug}`),
    };
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
    // Some APKMirror slugs append opaque tokens after the version with an underscore,
    // e.g. bbc-iplayer-android-tv-0-8-0_iyjcie_...-release. Strip those
    // tokens before matching so 0-8-0 becomes 0.8.0 rather than 0.8.
    rest = rest.replace(/_.+$/, '');
    const buildMatch = rest.match(/(?:^|-)build-(\d{2,})/i);
    if (buildMatch) rest = rest.slice(0, buildMatch.index);

    // APKMirror slugs sometimes append an internal app/build branch directly after
    // the app version, e.g. Prime Video:
    //   prime-video-android-tv-6-23-22v15-4-0-1009-armv7a-release
    // The public app version is 6.23.22. The old generic parser stopped at 6.23
    // because the next token was "22v15" rather than a plain hyphen-separated number.
    const embeddedBuildMatch = rest.match(/(?:^|-)(\d+(?:-\d+){1,5})v\d+(?=$|-)/i);
    if (embeddedBuildMatch) {
      return { version: this.hyphenVersionToDotted(embeddedBuildMatch[1]), version_code: buildMatch?.[1] || '' };
    }

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


  looksLikeBlockedSecurityPage(text) {
    const source = String(text || '');
    return /Just a moment\.\.\.|Performing security verification|Target URL returned error 403|requiring CAPTCHA|checks? if the site connection is secure|Cloudflare/i.test(source);
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

  hasUsableTvCandidate(candidates) {
    return (candidates || []).some(c => c && c.usable && c.tv_confirmed && this.isUsableVersion(c.version) && !this.isFireTvContext(c.url));
  }

  pickBestTvCandidate(candidates, packageName = '') {
    const rule = this.knownPackageBranchRule(packageName);
    const usable = candidates
      .filter(c => c && c.usable && c.tv_confirmed && this.isUsableVersion(c.version) && !this.isFireTvContext(c.url))
      // For known split mobile/TV package histories, do not allow a confirmed-looking
      // mobile branch to win just because a provider/source also exposes it. This keeps
      // Apple TV 2.x.x, GB News 2.x.x, Tai Chi 3.x.x and Tubi generic x.y.z rows out of
      // the final selection while leaving all other apps on the existing TV-evidence logic.
      .filter(c => !rule || rule.acceptVersion(c.version))
      .sort((a, b) => {
        // Prefer higher-quality evidence before comparing version numbers. A reader-text
        // fallback can occasionally pick up page metadata such as ratings (for example
        // 4.68) from a Jina/APKMirror page. Proper APKMirror release links/rows carry
        // higher confidence, so they should win over lower-confidence loose text matches.
        const qualityCompare = this.candidateQualityScore(b) - this.candidateQualityScore(a);
        if (qualityCompare !== 0) return qualityCompare;
        const confidenceCompare = Number(b.confidence || 0) - Number(a.confidence || 0);
        if (Math.abs(confidenceCompare) > 0.001) return confidenceCompare;
        const versionCompare = this.compareVersions(b.version, a.version);
        if (versionCompare !== 0) return versionCompare;
        const buildCompare = Number(b.version_code || 0) - Number(a.version_code || 0);
        if (buildCompare !== 0) return buildCompare;
        return 0;
      });
    return usable[0] || null;
  }

  candidateQualityScore(candidate = {}) {
    const note = String(candidate.note || '').toLowerCase();
    const evidence = String(candidate.tv_evidence || '').toLowerCase();
    const source = String(candidate.source || '').toLowerCase();

    if (source === 'google-play-scraper') return 90;
    if (note.includes('exact apkmirror android tv release url') || evidence.includes('exact android tv release')) return 88;
    if (note.includes('release link') || evidence.includes('release url/title')) return 82;
    if (note.includes('version-history row') || note.includes('branch') || evidence.includes('branch')) return 72;
    if (evidence.includes('tv-scoped')) return 68;
    if (note.includes('reader text') || evidence.includes('reader text line')) return 45;
    if (note.includes('search text') || evidence.includes('search result title/snippet')) return 42;
    return Math.round(Number(candidate.confidence || 0) * 50);
  }

  isLikelyRatingVersion(version = '', context = '') {
    const parts = String(version || '').split('.').map(v => Number.parseInt(v, 10));
    if (parts.length !== 2) return false;
    const [major, minor] = parts;
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
    if (major < 1 || major > 5 || minor < 0 || minor > 99) return false;
    const text = String(context || '').toLowerCase();
    if (/\b(rating|ratings|rated|star|stars|review|reviews|vote|votes|score)\b/.test(text)) return true;

    // APKMirror/Jina reader text can place an app title containing "Android TV" close
    // to page metadata such as a 4.xx star rating. Do not accept rating-shaped x.xx
    // values from loose reader text unless the chunk also looks like a release/version
    // row. Strong release-link candidates are handled separately and are unaffected.
    const releaseLike = /\b(version|release|apk\s+download|download\s+apk|uploaded|what'?s\s+new|variants?)\b/i.test(text);
    return !releaseLike;
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
    const timeout = Math.max(3000, Math.min(Number(timeoutOverrideMs || this.timeoutMs), this.timeoutMs));
    const host = this.hostFromUrl(url);
    const isJina = host === 'r.jina.ai';
    const attempts = isJina ? 2 : 1;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await this.waitForHostSlot(url);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
        const text = await response.text();
        if (response.status === 429 && attempt < attempts) {
          lastError = new Error(`HTTP 429`);
          this.blockHostTemporarily(host, 7000);
          await this.sleep(7000);
          continue;
        }
        if (!response.ok) {
          if (response.status === 429) this.blockHostTemporarily(host, 9000);
          throw new Error(`HTTP ${response.status}`);
        }
        return text;
      } catch (error) {
        if (error?.name === 'AbortError') lastError = new Error(`request timed out after ${timeout}ms`);
        else lastError = error;
        if (String(lastError?.message || '').includes('HTTP 429') && attempt < attempts) {
          this.blockHostTemporarily(host, 7000);
          await this.sleep(7000);
          continue;
        }
        throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError || new Error('fetch failed');
  }

  async waitForHostSlot(url) {
    const host = this.hostFromUrl(url);
    if (!host) return;
    const now = Date.now();
    const blockedUntil = Number(this.hostBlockedUntil.get(host) || 0);
    if (blockedUntil > now) await this.sleep(blockedUntil - now);

    // Jina is useful for blocked APKMirror pages, but it rate-limits quickly during
    // full-list checks. Pace it across requests on this Render instance.
    const minGap = host === 'r.jina.ai' ? 2200 : 250;
    const last = Number(this.hostLastFetchAt.get(host) || 0);
    const wait = Math.max(0, last + minGap - Date.now());
    if (wait > 0) await this.sleep(wait);
    this.hostLastFetchAt.set(host, Date.now());
  }

  blockHostTemporarily(host, ms) {
    if (!host || !ms) return;
    this.hostBlockedUntil.set(host, Math.max(Number(this.hostBlockedUntil.get(host) || 0), Date.now() + Number(ms || 0)));
  }

  hostFromUrl(url) {
    try { return new URL(String(url || '')).hostname.toLowerCase(); } catch (_) { return ''; }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms || 0))));
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
    const source = String(text || '');
    const labelled = source.match(/(?:Updated|Uploaded|Release Date|Date)[:\s]+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})/i);
    if (labelled) return labelled[1];
    const loose = source.match(/\b([A-Za-z]{3,9}\s+\d{1,2},\s+20\d{2}|20\d{2}-\d{2}-\d{2})\b/i);
    return loose ? loose[1] : '';
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
      .filter(c => (c.source === 'apkmirror-source-url' || c.source === 'apkpure-tv-url' || c.source === 'apkpure-package-versions-fallback' || c.source === 'apkfab-version-url' || c.source === 'aptoide-version-url') && c.version)
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
