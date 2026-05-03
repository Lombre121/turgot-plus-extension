// ════════════════════════════════════════
//  VIDEO.JS — POINT D'ENTRÉE
// ════════════════════════════════════════
window.stopAutoPreloader = true;

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { SUPABASE_URL, SUPABASE_KEY, injectNav, ICONS } from './config.js';
import {
  SERVERS,
  VIDSRC_API,
  loadIframe,
  loadMp4,
  loadVidsrcHLS,
  loadNexusHLS,
  nexusExtensionInstalled,
} from './sources.js';
import { renderServers, renderActions, renderEpisodeNav } from './ui.js';
import {
  loadPrefs, loadProgress, markWatched,
  watchedEpisodesForSeason, lastWatchedEpisode,
} from './prefs.js';

const findArchiveSources = window.findArchiveSources || (async () => []);
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── PARAMS ──────────────────────────────
const params  = new URLSearchParams(location.search);
const id      = params.get('id');
const type    = params.get('type') || 'movie';
let   season  = parseInt(params.get('season'))  || 1;
let   episode = parseInt(params.get('episode')) || 1;
const TMDB    = 'd40428d49744c5a2ba87bdad5d750538';

// ── STATE ────────────────────────────────
let session = null, item = null, originalLang = 'en', title = '';
let inWl = false, isWatched = false;
let currentServer = 'Videasy', currentMode = 'iframe'; // modes: 'iframe' | 'mp4' | 'hls' | 'nexus'
let archiveSources = [], totalEpisodes = 0;
let customPlayer = null;
let prefs = null;
let resume = null;
let watchedSet = new Set();
let langs = { hls: null };

// ── AUTH ─────────────────────────────────
window.__signOut = async () => { await sb.auth.signOut(); location.href = 'connexion.html'; };
const { data: sd } = await sb.auth.getSession();
session = sd.session;

// ── PRÉFS LECTEUR (chargées AVANT le 1er render player) ──
prefs = await loadPrefs(sb, session);

// ── TMDB ─────────────────────────────────
const resp = await fetch(`https://api.themoviedb.org/3/${type === 'movie' ? 'movie' : 'tv'}/${id}?api_key=${TMDB}&language=fr`);
item = await resp.json();
originalLang = item.original_language || 'en';
title = item.title || item.name || '';
document.title = `${title} – Turgot+`;
injectNav('', session);
document.getElementById('vtitle').textContent = title;
const year = (item.release_date || item.first_air_date || '').substring(0, 4);
const rating = item.vote_average ? `${item.vote_average.toFixed(1)} / 10` : '';
document.getElementById('vmeta').textContent = [year, rating].filter(Boolean).join(' · ');
if (type === 'tv') {
  const sInfo = (item.seasons || []).find(s => s.season_number === season);
  totalEpisodes = sInfo?.episode_count || 0;
}

// ── WATCHLIST ────────────────────────────
if (session) {
  const { data: wl } = await sb.from('watchlist').select('watched').eq('user_id', session.user.id).eq('tmdb_id', id).eq('media_type', type).maybeSingle();
  inWl = !!wl; isWatched = wl?.watched || false;
}

// ── PROGRESSION (resume) ─────────────────
async function refreshProgressInfo() {
  resume = await loadProgress(sb, session, id, type, type === 'tv' ? season : 0, type === 'tv' ? episode : 0);
  if (type === 'tv') {
    watchedSet = await watchedEpisodesForSeason(sb, session, id, season);
  }
}
await refreshProgressInfo();

// ── ARCHIVE SOURCES ──────────────────────
findArchiveSources(id, originalLang).then(sources => {
  archiveSources = sources || [];
  redraw();
});

// ── HELPERS pour passer le ctx Supabase au player ─
function playerCtxBase() {
  return {
    sb, session, prefs, resume,
    onProgress: ({ watched }) => {
      if (watched && type === 'tv' && !watchedSet.has(episode)) {
        watchedSet.add(episode);
        redrawEpisodeNav();
      }
      if (watched && !isWatched) {
        isWatched = true;
        redrawActions();
        sb.from('watchlist').upsert({
          user_id: session.user.id, tmdb_id: id, media_type: type,
          title, poster: item.poster_path, watched: true,
          added_at: new Date().toISOString(),
        }).catch(() => {});
      }
    },
  };
}

/**
 * Capture la position de lecture actuelle dans `resume` ET flush immédiatement
 * la progression vers Supabase avant de changer de lecteur/serveur.
 */
async function flushCurrentAndCapture() {
  if (!customPlayer) return;
  try {
    const pos = customPlayer.video?.currentTime;
    const dur = customPlayer.video?.duration;
    if (pos > 2 && dur > 0 && pos / dur < 0.98) {
      resume = { position: pos, duration: dur };
    }
    await customPlayer._flushProgressNow();
  } catch(e) { /* silencieux */ }
}

// ── REDRAW SERVERS ───────────────────────
function redraw() {
  renderServers({
    currentMode,
    currentServer,
    archiveSources,
    langs,
    ctx: { type, tmdbId: id, season: type === 'tv' ? season : undefined, episode: type === 'tv' ? episode : undefined },
    onIframe: async (name, customUrl) => {
      await flushCurrentAndCapture();
      currentMode = 'iframe';
      currentServer = name;
      customPlayer = loadIframe(currentServer, type, id, season, episode, customPlayer, customUrl);
      redraw();
    },
    onMp4: async () => {
      await flushCurrentAndCapture();
      currentMode = 'mp4';
      customPlayer = loadMp4(archiveSources, customPlayer, type, id, season, episode, originalLang, title, playerCtxBase());
      redraw();
    },
    onHls: async () => {
      await flushCurrentAndCapture();
      currentMode = 'hls';
      langs.hls = null;
      redraw();
      loadVidsrcHLS(type, id, season, episode, originalLang, title, customPlayer, (lang) => {
        langs.hls = lang;
        redraw();
      }, playerCtxBase()).then(p => { customPlayer = p; });
    },
    onNexus: async () => {
      await flushCurrentAndCapture();
      currentMode = 'nexus';
      redraw();
      loadNexusHLS(type, id, season, episode, originalLang, title, customPlayer, playerCtxBase()).then(p => { customPlayer = p; });
    },
  });
}

// ── ACTIONS ──────────────────────────────
function redrawActions() {
  renderActions({
    session, inWl, isWatched, ICONS,
    onWl: async () => {
      if (!session) return (location.href = 'connexion.html');
      if (inWl) {
        await sb.from('watchlist').delete().eq('user_id', session.user.id).eq('tmdb_id', id).eq('media_type', type);
        inWl = false;
      } else {
        await sb.from('watchlist').upsert({ user_id: session.user.id, tmdb_id: id, media_type: type, title, poster: item.poster_path, watched: false, added_at: new Date().toISOString() });
        inWl = true;
      }
      redrawActions();
    },
    onWo: async () => {
      if (!session) return (location.href = 'connexion.html');
      isWatched = !isWatched;
      inWl = true;
      await sb.from('watchlist').upsert({
        user_id: session.user.id, tmdb_id: id, media_type: type,
        title, poster: item.poster_path, watched: isWatched,
        added_at: new Date().toISOString(),
      });
      await markWatched(sb, session, {
        tmdbId: id, mediaType: type,
        season:  type === 'tv' ? season  : 0,
        episode: type === 'tv' ? episode : 0,
        watched: isWatched,
      });
      if (type === 'tv') {
        if (isWatched) watchedSet.add(episode); else watchedSet.delete(episode);
        redrawEpisodeNav();
      }
      redrawActions();
    },
  });
}

// ── ÉPISODES ─────────────────────────────
function redrawEpisodeNav() {
  renderEpisodeNav({
    type, season, episode, totalEpisodes,
    watchedSet,
    onChange: async (delta) => {
      const newEp = episode + delta;
      if (newEp < 1 || (totalEpisodes && newEp > totalEpisodes)) return;
      episode = newEp;
      const u = new URL(location.href);
      u.searchParams.set('episode', episode);
      history.replaceState(null, '', u.toString());

      await refreshProgressInfo();
      if (type === 'tv') {
        const wl = await sb.from('progress').select('watched').eq('user_id', session.user.id).eq('tmdb_id', id).eq('media_type','tv').eq('season', season).eq('episode', episode).maybeSingle();
        isWatched = !!wl.data?.watched;
      }

      if (currentMode === 'iframe')
        customPlayer = loadIframe(currentServer, type, id, season, episode, customPlayer);
      else if (currentMode === 'mp4')
        customPlayer = loadMp4(archiveSources, customPlayer, type, id, season, episode, originalLang, title, playerCtxBase());
      else if (currentMode === 'hls')
        loadVidsrcHLS(type, id, season, episode, originalLang, title, customPlayer, (lang)=>{ langs.hls=lang; redraw(); }, playerCtxBase()).then(p => { customPlayer = p; });
      else if (currentMode === 'nexus')
        loadNexusHLS(type, id, season, episode, originalLang, title, customPlayer, playerCtxBase()).then(p => { customPlayer = p; });

      redraw();
      redrawEpisodeNav();
      redrawActions();
    },
  });
}

// ── BOUTON RETOUR ────────────────────────
const backBtn = document.getElementById('btn-back');
if (backBtn) {
  backBtn.onclick = () => {
    if (history.length > 1) history.back();
    else location.href = `details.html?id=${id}&type=${type}`;
  };
}

// ── INIT ─────────────────────────────────
redrawActions();
redraw();
redrawEpisodeNav();

document.getElementById('top-loader').style.display = 'none';
document.getElementById('video-main').style.display = 'block';
document.getElementById('preloader').style.display = 'none';

// Charge le serveur par défaut selon la préférence utilisateur
const ds = prefs?.defaultServer || 'iframe';
if (ds === 'hls') {
  currentMode = 'hls'; langs.hls = null; redraw();
  loadVidsrcHLS(type, id, season, episode, originalLang, title, customPlayer, (lang) => { langs.hls = lang; redraw(); }, playerCtxBase()).then(p => { customPlayer = p; });
} else {
  customPlayer = loadIframe(currentServer, type, id, season, episode, customPlayer);
}
