// ════════════════════════════════════════
//  SOURCES & SERVEURS
// ════════════════════════════════════════
import { CustomPlayer } from './player.js';

// =============================================
// CONSTANTES GLOBALES
// =============================================
export const VIDSRC_API        = 'https://railway-up-production-b18a.up.railway.app';
export const MOVIX_API         = 'https://api.movix.cash';
export const OPENSUBS_REST_API = 'https://rest.opensubtitles.org/search';
export const OPENSUBS_API      = 'https://sub.wyzie.ru/search';

const TMDB_API_KEY = 'd40428d49744c5a2ba87bdad5d750538';
const imdbCache = new Map();

export const SUBS_SERVER = (typeof window !== 'undefined' && window.SUBS_SERVER)
  ? window.SUBS_SERVER.replace(/\/+$/, '')
  : 'https://sub-proxy.onrender.com';

// =============================================
// LISTE DES SERVEURS IFRAME
// =============================================
export const SERVERS = {
  'Videasy':   { movie: (id) => `https://player.videasy.net/movie/${id}`,         tv: (id,s,e) => `https://player.videasy.net/tv/${id}/${s}/${e}` },
  'Vidlink':   { movie: (id) => `https://vidlink.pro/movie/${id}`,                tv: (id,s,e) => `https://vidlink.pro/tv/${id}/${s}/${e}` },
  'Vidsource': { movie: (id) => `https://vidrock.ru/movie/${id}`,                 tv: (id,s,e) => `https://vidrock.ru/tv/${id}/${s}/${e}` },
  '111movies': { movie: (id) => `https://111movies.com/movie/${id}`,              tv: (id,s,e) => `https://111movies.com/tv/${id}/${s}/${e}` },
  'Frembed':   { movie: (id) => `https://frembed.click/api/film?id=${id}`,        tv: (id,s,e) => `https://frembed.click/api/serie?id=${id}&sa=${s}&epi=${e}` },
};

// =============================================
// UTILITAIRES
// =============================================
function getFlagEmoji(lang) {
  const flags = {
    fre: '🇫🇷', fr: '🇫🇷', 'fr-fr': '🇫🇷',
    en: '🇬🇧', 'en-us': '🇺🇸', 'en-gb': '🇬🇧',
    es: '🇪🇸', de: '🇩🇪', it: '🇮🇹', pt: '🇵🇹', ru: '🇷🇺',
    ar: '🇦🇪', ja: '🇯🇵', ko: '🇰🇷', zh: '🇨🇳',
  };
  return flags[lang.toLowerCase()] || '🌍';
}

export function ensureIframeNode(customPlayer) {
  const wrap = document.getElementById('player-wrap');
  if (customPlayer) { customPlayer.destroy(); customPlayer = null; }
  if (!document.getElementById('player')) {
    wrap.innerHTML = `<iframe id="player" allowfullscreen allow="autoplay; fullscreen; encrypted-media"></iframe>`;
  }
  return customPlayer;
}

export function loadIframe(currentServer, type, id, season, episode, customPlayer, customUrl) {
  customPlayer = ensureIframeNode(customPlayer);
  let url;
  if (customUrl) {
    url = customUrl;
  } else {
    const srv = SERVERS[currentServer];
    url = type === 'movie' ? srv.movie(id) : srv.tv(id, season, episode);
  }
  document.getElementById('player').src = url;
  return customPlayer;
}

export function loadMp4(archiveSources, customPlayer, type, id, season, episode, originalLang, title, extraCtx = {}) {
  const wrap  = document.getElementById('player-wrap');
  const iframe = document.getElementById('player');
  if (iframe) iframe.remove();
  const sources = archiveSources.map(s => ({
    url: s.url, isHls: false, format: 'mp4',
    quality: s.quality, origin: 'archive', language: 'VO',
  }));
  if (customPlayer) { customPlayer.destroy(); customPlayer = null; }
  customPlayer = new CustomPlayer(wrap, sources, { tmdbId: id, type, season, episode, originalLang, title, ...extraCtx });
  return customPlayer;
}

// =============================================
// TMDB → IMDB
// =============================================
async function getImdbId(tmdbId, type) {
  const cacheKey = `${type}-${tmdbId}`;
  if (imdbCache.has(cacheKey)) return imdbCache.get(cacheKey);
  try {
    const url = type === 'tv'
      ? `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
      : `https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    const imdbId = data.imdb_id || null;
    imdbCache.set(cacheKey, imdbId);
    return imdbId;
  } catch (e) { console.warn('[TMDB→IMDB]', e.message); return null; }
}

// =============================================
// SOUS-TITRES — OpenSubtitles REST (principal)
// =============================================
export async function loadPrimarySubtitles(type, tmdbId, customPlayer, season, episode) {
  if (!customPlayer) return;
  try {
    const imdbId = await getImdbId(tmdbId, type);
    if (!imdbId) return;
    const url = type === 'tv'
      ? `${OPENSUBS_REST_API}/episode-${episode}/imdbid-${imdbId.replace('tt','')}/season-${season}`
      : `${OPENSUBS_REST_API}/imdbid-${imdbId.replace('tt','')}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${SUBS_SERVER}/proxy?url=${encodeURIComponent(url)}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data)) return;
    const priorityLangs = ['fre', 'fr', 'fr-fr', 'en', 'en-us', 'en-gb'];
    const sorted = [...data].sort((a, b) => {
      const ia = priorityLangs.indexOf((a.SubLanguageID || '').toLowerCase());
      const ib = priorityLangs.indexOf((b.SubLanguageID || '').toLowerCase());
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const seen = new Set();
    const subs = [];
    for (const item of sorted) {
      const lang = (item.SubLanguageID || '').toLowerCase();
      const link = item.SubDownloadLink;
      if (!lang || !link || seen.has(lang) || item.SubBad || !item.SubDownloadsCnt) continue;
      seen.add(lang);
      subs.push({
        language: lang,
        language_name: (item.LanguageName || lang).toUpperCase(),
        url: `${SUBS_SERVER}/proxy?url=${encodeURIComponent(link)}`,
        source: 'OP',
        flag: getFlagEmoji(lang),
        downloadCount: item.SubDownloadsCnt || 0,
      });
      if (subs.length >= 6) break;
    }
    if (subs.length > 0) customPlayer.populateSubsLangs(subs);
  } catch (e) { console.warn('[Primary Subtitles]', e.message); }
}

// =============================================
// SOUS-TITRES — OpenSubtitles v1 (backup)
// =============================================
export async function loadBackupSubtitles(type, tmdbId, customPlayer, season, episode) {
  if (!customPlayer) return;
  try {
    const params = new URLSearchParams({ tmdb_id: String(tmdbId), languages: 'fr,en', dev_mode: 'true' });
    if (type === 'tv') {
      if (season  != null) params.set('season_number',  String(season));
      if (episode != null) params.set('episode_number', String(episode));
    }
    const res = await fetch(`https://api.opensubtitles.com/api/v1/subtitles?${params}`, {
      headers: { 'Api-Key': 'SDaxJh7iN5tBEeyoOPflkwrEB9hwJHfH', 'Content-Type': 'application/json' },
    });
    if (!res.ok) return;
    const json = await res.json();
    const list = json.data || [];
    if (!list.length) return;
    const seen = new Set();
    const subs = [];
    for (const item of list) {
      const lang = (item.attributes?.language || '').toLowerCase();
      if (!lang || seen.has(lang)) continue;
      seen.add(lang);
      const file = item.attributes?.files?.[0];
      if (!file?.file_id) continue;
      const dlRes = await fetch('https://api.opensubtitles.com/api/v1/download', {
        method: 'POST',
        headers: { 'Api-Key': 'SDaxJh7iN5tBEeyoOPflkwrEB9hwJHfH', 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: file.file_id, sub_format: 'srt' }),
      });
      if (!dlRes.ok) continue;
      const dlJson = await dlRes.json();
      if (!dlJson.link) continue;
      subs.push({
        language:      lang,
        language_name: lang.toUpperCase(),
        url:           `${SUBS_SERVER}/proxy?url=${encodeURIComponent(dlJson.link)}`,
        source:        'op',
        flag:          getFlagEmoji(lang),
      });
      if (subs.length >= 4) break;
    }
    if (subs.length) customPlayer.populateSubsLangs(subs);
  } catch(e) { console.warn('[Backup Subtitles]', e.message); }
}

// =============================================
// HELPERS INTERNES
// =============================================
function ensureHlsLoaded() {
  if (window.Hls) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Impossible de charger hls.js'));
    document.head.appendChild(s);
  });
}

function showServerError(wrap, info) {
  const bits = Object.entries(info)
    .filter(([_, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<div><b style="color:#fbb">${k}</b>: <span style="word-break:break-all">${String(v).slice(0,800)}</span></div>`)
    .join('');
  wrap.innerHTML = `
    <div style="color:#fff;padding:1.5rem;font:13px/1.5 ui-monospace,monospace;background:#1a0e0e;border:1px solid #5a1a1a;border-radius:.5rem;margin:1rem;overflow:auto">
      <div style="font:600 1.1rem system-ui;color:#f66;margin-bottom:.8rem">❌ Erreur — diagnostic</div>
      ${bits}
    </div>`;
}

// =============================================
// CINEPRO / VIDSRC
// =============================================
export async function loadVidsrcHLS(type, id, season, episode, originalLang, title, customPlayer, onLangChange, extraCtx = {}) {
  const wrap  = document.getElementById('player-wrap');
  const iframe = document.getElementById('player');
  if (iframe) iframe.remove();
  if (customPlayer) { customPlayer.destroy(); customPlayer = null; }

  wrap.innerHTML = `<div style="color:#fff;padding:2rem;text-align:center;font-size:1rem">⏳ Chargement CinePro...</div>`;

  try {
    const apiUrl = type === 'tv'
      ? `${VIDSRC_API}/v1/tv/${id}/seasons/${season}/episodes/${episode}`
      : `${VIDSRC_API}/v1/movies/${id}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(apiUrl, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();

    if (!data.sources || data.sources.length === 0) {
      wrap.innerHTML = `<div style="color:#f66;padding:2rem;text-align:center">❌ Source CinePro indisponible</div>`;
      return null;
    }

    const fixUrl = url => url.replace('http://localhost:8080', VIDSRC_API);
    const hlsSources = data.sources.filter(s => s.type === 'hls')
      .map(s => ({ quality: s.quality||'Auto', url: fixUrl(s.url), isHls: true, format: 'hls', origin: 'cinepro', language: 'VO' }));
    const mp4Sources = data.sources.filter(s => s.type === 'mp4')
      .map(s => ({ quality: s.quality||'SD', url: fixUrl(s.url), isHls: false, format: 'mp4', origin: 'cinepro', language: 'VO' }));
    const sources = hlsSources.length > 0 ? hlsSources : mp4Sources;

    if (!sources.length) {
      wrap.innerHTML = `<div style="color:#f66;padding:2rem;text-align:center">❌ Aucune source lisible</div>`;
      return null;
    }

    if (!window.Hls) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/hls.js@latest';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    wrap.innerHTML = '';
    customPlayer = new CustomPlayer(wrap, sources, { tmdbId: id, type, season, episode, originalLang, title, ...extraCtx });

    if (typeof onLangChange === 'function') {
      const subs = Array.isArray(data.subtitles) ? data.subtitles : [];
      const hasFr = subs.some(s => /\bfr\b|french|français|fre/i.test(s.label || ''));
      onLangChange(hasFr ? 'VO+FR.sub' : 'VO');
    }

    if (data.subtitles?.length) {
      setTimeout(() => {
        if (!customPlayer) return;
        customPlayer.populateSubsLangs(data.subtitles.map(s => ({
          language: s.label||'unknown', language_name: s.label||'Inconnu', url: fixUrl(s.url), source: 'flux',
        })));
      }, 300);
    }

    loadPrimarySubtitles(type, id, customPlayer, season, episode);
    setTimeout(() => loadBackupSubtitles(type, id, customPlayer, season, episode), 1500);
    return customPlayer;

  } catch(e) {
    wrap.innerHTML = `<div style="color:#f66;padding:2rem;text-align:center">❌ CinePro : ${e.message}</div>`;
    return null;
  }
}

// =============================================
// EMBEDS IMDB (dropdown Iframe ▾)
// =============================================
export async function fetchImdbEmbeds(type, tmdbId, season, episode) {
  // Les URLs api.movix.cash bloquent l'iframe (X-Frame-Options: DENY).
  // On les marque newTab:true pour les ouvrir dans un nouvel onglet.
  const movixEmbeds = [];
  if (type === 'movie') {
    movixEmbeds.push({ url: `${MOVIX_API}/api/tmdb/movie/${tmdbId}`, label: 'CinePulse VF/VO', language: 'VF', newTab: true });
  } else {
    const imdbId = await getImdbId(tmdbId, 'tv');
    if (imdbId) movixEmbeds.push({ url: `${MOVIX_API}/api/imdb/tv/${imdbId}`, label: 'CinePulse VF/VO', language: 'VF', newTab: true });
  }
  return movixEmbeds;
}

// =============================================
// TÉLÉCHARGEMENTS MOVIX
// =============================================
export async function fetchMovixDownloads(type, tmdbId, season, episode) {
  try {
    const url = type === 'movie'
      ? `${MOVIX_API}/api/films/download/${tmdbId}`
      : `${MOVIX_API}/api/series/download/${tmdbId}/season/${season}/episode/${episode}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal, credentials: 'omit' });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const data = await res.json();
    const items = data.links || data.downloads || data.sources || (Array.isArray(data) ? data : []);
    if (!items.length && data.url) return [{ url: data.url, label: 'Télécharger', quality: data.quality||'1080p' }];
    return items.map(d => ({
      url:     d.url || d.link || d.download_url || '',
      label:   d.label || d.quality || '1080p',
      quality: d.quality || d.resolution || '?',
    })).filter(d => d.url);
  } catch { return []; }
}

// =============================================
// NEXUS — extraction HLS via l'extension Tampermonkey
// =============================================
export function nexusExtensionInstalled() {
  return !!(window.__MOVIX_EXTENSION_INSTALLED || typeof window.movixExtractAllM3u8 === 'function');
}

export async function loadNexusHLS(type, id, season, episode, originalLang, title, customPlayer, extraCtx = {}) {
  const wrap  = document.getElementById('player-wrap');
  const iframe = document.getElementById('player');
  if (iframe) iframe.remove();
  if (customPlayer) { customPlayer.destroy(); customPlayer = null; }

  if (!nexusExtensionInstalled()) {
    wrap.innerHTML = `<div style="color:#f66;padding:2rem;text-align:center;font-size:.95rem">
      ❌ Extension Nexus non détectée.<br><small style="color:#aaa">Installez le script Tampermonkey Turgot+ et rechargez la page.</small>
    </div>`;
    return null;
  }

  wrap.innerHTML = `<div style="color:#fff;padding:2rem;text-align:center;font-size:1rem">🔍 Nexus : recherche de sources...</div>`;

  try {
    const downloads = await fetchMovixDownloads(type, id, season, episode);
    if (!downloads.length) {
      wrap.innerHTML = `<div style="color:#f66;padding:2rem;text-align:center">❌ Nexus : aucune source disponible pour ce titre.</div>`;
      return null;
    }

    wrap.innerHTML = `<div style="color:#fff;padding:2rem;text-align:center;font-size:1rem">⚙️ Nexus : extraction en cours (${downloads.length} source${downloads.length > 1 ? 's' : ''})...</div>`;

    const sources = downloads.map(d => ({ url: d.url, label: d.label || d.quality || 'Source' }));
    const result  = await window.movixExtractAllM3u8(sources);

    if (!result || !result.successCount) {
      wrap.innerHTML = `<div style="color:#f66;padding:2rem;text-align:center">❌ Nexus : extraction échouée (${result?.successCount ?? 0}/${result?.total ?? downloads.length} sources).</div>`;
      return null;
    }

    const playerSources = (result.results || [])
      .filter(r => r.success && (r.hlsUrl || r.m3u8Url))
      .map((r, i) => ({
        url:      r.hlsUrl || r.m3u8Url,
        isHls:    true,
        format:   'hls',
        quality:  downloads[i]?.label || r.source || 'Auto',
        origin:   'nexus',
        language: 'VO',
      }));

    if (!playerSources.length) {
      wrap.innerHTML = `<div style="color:#f66;padding:2rem;text-align:center">❌ Nexus : aucune URL HLS extraite.</div>`;
      return null;
    }

    await ensureHlsLoaded();
    wrap.innerHTML = '';
    customPlayer = new CustomPlayer(wrap, playerSources, { tmdbId: id, type, season, episode, originalLang, title, ...extraCtx });

    loadPrimarySubtitles(type, id, customPlayer, season, episode);
    setTimeout(() => loadBackupSubtitles(type, id, customPlayer, season, episode), 1500);

    return customPlayer;

  } catch (e) {
    wrap.innerHTML = `<div style="color:#f66;padding:2rem;text-align:center">❌ Nexus : ${e.message}</div>`;
    return null;
  }
}

// =============================================
// EXPORT PAR DÉFAUT
// =============================================
export default {
  loadPrimarySubtitles, loadBackupSubtitles,
  loadVidsrcHLS, loadNexusHLS, nexusExtensionInstalled,
  fetchImdbEmbeds, fetchMovixDownloads,
  OPENSUBS_REST_API, OPENSUBS_API, VIDSRC_API, MOVIX_API,
  SERVERS,
};
