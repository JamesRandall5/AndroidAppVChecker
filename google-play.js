const PLAY_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

class GooglePlayProvider {
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

  playUrl(packageName) {
    return `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageName)}&hl=${encodeURIComponent(this.language)}&gl=${encodeURIComponent(this.country.toUpperCase())}`;
  }

  async lookup(packageName) {
    const issues = [];

    try {
      const gplay = await this.loadScraper();
      const app = await gplay.app({
        appId: packageName,
        lang: this.language,
        country: this.country,
      });

      const result = {
        ok: true,
        package_name: packageName,
        title: String(app?.title || ''),
        developer: String(app?.developer || app?.developerName || ''),
        version: String(app?.version || ''),
        updated: String(app?.updated || app?.released || ''),
        source: 'google-play-scraper',
        url: String(app?.url || this.playUrl(packageName)),
      };

      if (result.version) {
        return result;
      }

      issues.push('google-play-scraper returned no version');
    } catch (error) {
      issues.push(`google-play-scraper failed: ${error.message || 'Unknown error'}`);
    }

    try {
      const fallback = await this.lookupViaPage(packageName);
      if (fallback.version) {
        return {
          ...fallback,
          warning: issues.join(' | '),
        };
      }
      issues.push('Play page fallback returned no version');
    } catch (error) {
      issues.push(`Play page fallback failed: ${error.message || 'Unknown error'}`);
    }

    return {
      ok: false,
      package_name: packageName,
      error: issues.join(' || '),
      url: this.playUrl(packageName),
    };
  }

  async lookupViaPage(packageName) {
    const url = this.playUrl(packageName);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': PLAY_UA,
          'Accept-Language': `${this.language}-${this.country.toUpperCase()},${this.language};q=0.9`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();
      return {
        ok: true,
        package_name: packageName,
        title: this.extractMeta(html, 'og:title') || this.extractJsonLdField(html, 'name') || '',
        developer: this.extractAuthorName(html),
        version: this.extractVersion(html),
        updated: this.extractUpdatedDate(html),
        source: 'google-play-page-fallback',
        url,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  extractMeta(html, property) {
    const regex = new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, 'i');
    return this.decode(regex.exec(html)?.[1] || '');
  }

  extractJsonLdField(html, field) {
    const blocks = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const block of blocks) {
      const content = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
      try {
        const json = JSON.parse(content);
        if (json && typeof json === 'object' && field in json) {
          return this.decode(String(json[field] || ''));
        }
      } catch {
        // ignore invalid JSON-LD block
      }
    }
    return '';
  }

  extractAuthorName(html) {
    const match = /"author"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i.exec(html)?.[1];
    return this.decode(match || '');
  }

  extractVersion(html) {
    const patterns = [
      /"softwareVersion"\s*:\s*"([^"]+)"/i,
      /Current Version[\s\S]{0,300}?>([0-9][^<]{0,40})</i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match?.[1]) return this.decode(match[1].trim());
    }
    return '';
  }

  extractUpdatedDate(html) {
    const patterns = [
      /"datePublished"\s*:\s*"([^"]+)"/i,
      /Updated on[\s\S]{0,200}?>([^<]{4,40})</i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(html);
      if (match?.[1]) return this.decode(match[1].trim());
    }
    return '';
  }

  decode(value) {
    return String(value || '')
      .replace(/\\u003d/g, '=')
      .replace(/\\u0026/g, '&')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"');
  }
}

module.exports = { GooglePlayProvider };
