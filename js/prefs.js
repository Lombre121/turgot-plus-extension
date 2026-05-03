// ════════════════════════════════════════
//  PREFS LECTEUR + PROGRESSION (Supabase)
//
//  Tables / vue Supabase requises (cf. SQL dans replit.md) :
//    - public.profiles.prefs_player jsonb
//    - public.progress (user_id, tmdb_id, media_type, season, episode,
//                       position, duration, watched, updated_at)
//    - public.likes_counts (vue agrégée)
// ════════════════════════════════════════

const PREFS_LS_KEY = 'turgot_player_prefs';

export const DEFAULT_PREFS = {
  bright:    1.23,
  contrast:  1.02,
  sat:       1.11,
  gain:      1,
  speed:     1,
  subSize:   22,
  subColor:  '#ffffff',
  subBg:     true,
  subBottom: 14,
  volume:    1,
  fitCover:  false,
  defaultSubLang:  'fr',    // 'fr' | 'en' | 'off' — langue ST chargée automatiquement
  defaultServer:   'iframe', // 'iframe' | 'hls' | 'myserver' | 'cinepulse' — serveur chargé au démarrage
  // Mémorisés pour reproposer la même source au prochain run :
  preferredOrigin: null,    // 'cinepro' | 'movix' | 'nightflix' | 'rivestream' | 'imdb'
  preferredLang:   null,    // 'VF' | 'VFF' | 'VFQ' | 'VOSTFR' | 'VO' | 'VO+FR.sub' | 'MULTI'
};

/* ───────────── PRÉFÉRENCES LECTEUR ───────────── */

function readLocal() {
  try {
    const raw = localStorage.getItem(PREFS_LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}
function writeLocal(prefs) {
  try { localStorage.setItem(PREFS_LS_KEY, JSON.stringify(prefs)); } catch {}
}

/**
 * Charge les préférences. Priorité : Supabase (si session) > localStorage > défauts.
 * Met à jour le localStorage en passant — comme ça le prochain rendu est instantané.
 */
export async function loadPrefs(sb, session) {
  const local = readLocal() || {};
  let merged = { ...DEFAULT_PREFS, ...local };

  if (sb && session) {
    try {
      const { data } = await sb
        .from('profiles')
        .select('prefs_player')
        .eq('id', session.user.id)
        .maybeSingle();
      if (data?.prefs_player && typeof data.prefs_player === 'object') {
        merged = { ...merged, ...data.prefs_player };
        writeLocal(merged);
      }
    } catch (e) {
      console.warn('loadPrefs:', e.message);
    }
  }
  return merged;
}

let _saveTimer = null;
let _pendingPrefs = null;
/**
 * Sauvegarde les préférences (debounce 800ms côté Supabase). Le localStorage
 * lui est mis à jour immédiatement.
 */
export function savePrefs(sb, session, partial, opts = {}) {
  const current = readLocal() || {};
  const next = { ...DEFAULT_PREFS, ...current, ...partial };
  writeLocal(next);
  if (!sb || !session) return Promise.resolve();
  const flush = async () => {
    const toSave = _pendingPrefs ?? next;
    _pendingPrefs = null;
    try {
      await sb
        .from('profiles')
        .update({ prefs_player: toSave })
        .eq('id', session.user.id);
    } catch (e) {
      console.warn('savePrefs:', e.message);
    }
  };
  if (opts.immediate) {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    _pendingPrefs = next;
    return flush();
  }
  _pendingPrefs = next;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flush, 800);
  return Promise.resolve();
}

/* ───────────── PROGRESSION ───────────── */

/**
 * Renvoie { position, duration, watched } pour cet épisode/film, ou null.
 */
export async function loadProgress(sb, session, tmdbId, mediaType, season = 0, episode = 0) {
  if (!sb || !session) return null;
  try {
    const { data } = await sb
      .from('progress')
      .select('position,duration,watched')
      .eq('user_id', session.user.id)
      .eq('tmdb_id', Number(tmdbId))
      .eq('media_type', mediaType)
      .eq('season',  mediaType === 'tv' ? Number(season)  : 0)
      .eq('episode', mediaType === 'tv' ? Number(episode) : 0)
      .maybeSingle();
    return data || null;
  } catch (e) {
    console.warn('loadProgress:', e.message);
    return null;
  }
}

let _progressTimer = null;
/**
 * Sauvegarde la progression toutes les 5 secondes au max. À 95% on marque
 * `watched=true` automatiquement.
 */
export function saveProgress(sb, session, { tmdbId, mediaType, season = 0, episode = 0, position, duration }) {
  if (!sb || !session) return;
  if (!isFinite(position) || !isFinite(duration) || duration <= 0) return;
  if (_progressTimer) return; // déjà programmé pour les 5 prochaines secondes
  _progressTimer = setTimeout(async () => {
    _progressTimer = null;
    const watched = position / duration >= 0.95;
    try {
      await sb.from('progress').upsert({
        user_id:    session.user.id,
        tmdb_id:    Number(tmdbId),
        media_type: mediaType,
        season:     mediaType === 'tv' ? Number(season)  : 0,
        episode:    mediaType === 'tv' ? Number(episode) : 0,
        position:   Math.floor(position),
        duration:   Math.floor(duration),
        watched,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,tmdb_id,media_type,season,episode',
      });
    } catch (e) {
      console.warn('saveProgress:', e.message);
    }
  }, 5000);
}

/**
 * Force un flush immédiat (à appeler au unload de la page ou au switch de
 * source) pour ne pas perdre les 5 dernières secondes.
 */
export async function flushProgress(sb, session, payload) {
  if (!sb || !session) return;
  if (_progressTimer) { clearTimeout(_progressTimer); _progressTimer = null; }
  try {
    const watched = payload.duration > 0 && payload.position / payload.duration >= 0.95;
    await sb.from('progress').upsert({
      user_id:    session.user.id,
      tmdb_id:    Number(payload.tmdbId),
      media_type: payload.mediaType,
      season:     payload.mediaType === 'tv' ? Number(payload.season)  : 0,
      episode:    payload.mediaType === 'tv' ? Number(payload.episode) : 0,
      position:   Math.floor(payload.position),
      duration:   Math.floor(payload.duration),
      watched,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'user_id,tmdb_id,media_type,season,episode',
    });
  } catch (e) {
    console.warn('flushProgress:', e.message);
  }
}

export async function clearProgress(sb, session, tmdbId, mediaType) {
  if (!sb || !session) return;
  try {
    await sb.from('progress').delete()
      .eq('user_id', session.user.id)
      .eq('tmdb_id', Number(tmdbId))
      .eq('media_type', mediaType);
  } catch (e) {
    console.warn('clearProgress:', e.message);
  }
}

/**
 * Marque un épisode/film comme vu (sans toucher à position/duration s'ils
 * existent déjà — sinon position=duration=0 et watched=true).
 */
export async function markWatched(sb, session, { tmdbId, mediaType, season = 0, episode = 0, watched = true }) {
  if (!sb || !session) return;
  try {
    const existing = await loadProgress(sb, session, tmdbId, mediaType, season, episode);
    await sb.from('progress').upsert({
      user_id:    session.user.id,
      tmdb_id:    Number(tmdbId),
      media_type: mediaType,
      season:     mediaType === 'tv' ? Number(season)  : 0,
      episode:    mediaType === 'tv' ? Number(episode) : 0,
      position:   existing?.position ?? 0,
      duration:   existing?.duration ?? 0,
      watched,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'user_id,tmdb_id,media_type,season,episode',
    });
  } catch (e) {
    console.warn('markWatched:', e.message);
  }
}

/**
 * Pour une série : renvoie l'épisode "à reprendre" sous la forme
 * { season, episode, position, duration, watched } ou null si rien à reprendre.
 *
 * Logique :
 *   1. S'il existe une progression non-vu (watched=false, position>0), la prendre.
 *   2. Sinon, chercher le dernier (season, episode) marqué vu et proposer
 *      l'épisode SUIVANT (s+1 ou e+1).
 *   3. Sinon null (= début S1E1).
 */
export async function lastWatchedEpisode(sb, session, tmdbId) {
  if (!sb || !session) return null;
  try {
    // 1) reprise en cours
    const { data: ongoing } = await sb
      .from('progress')
      .select('season,episode,position,duration,watched,updated_at')
      .eq('user_id',   session.user.id)
      .eq('tmdb_id',   Number(tmdbId))
      .eq('media_type','tv')
      .eq('watched',   false)
      .gt('position',  20)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (ongoing && ongoing.length > 0) {
      return { ...ongoing[0], resume: true };
    }
    // 2) prochain épisode après le dernier vu
    const { data: lastSeen } = await sb
      .from('progress')
      .select('season,episode,duration')
      .eq('user_id',   session.user.id)
      .eq('tmdb_id',   Number(tmdbId))
      .eq('media_type','tv')
      .eq('watched',   true)
      .order('season',  { ascending: false })
      .order('episode', { ascending: false })
      .limit(1);
    if (lastSeen && lastSeen.length > 0) {
      const { season, episode, duration } = lastSeen[0];
      return {
        season,
        episode: episode + 1,           // suivant
        position: 0,
        duration: duration || 0,
        watched: false,
        resume: false,
        next: true,
      };
    }
    return null;
  } catch (e) {
    console.warn('lastWatchedEpisode:', e.message);
    return null;
  }
}

/**
 * Renvoie la liste des épisodes vus pour une saison donnée
 * → Set<number> des numéros d'épisodes vus.
 */
export async function watchedEpisodesForSeason(sb, session, tmdbId, season) {
  const out = new Set();
  if (!sb || !session) return out;
  try {
    const { data } = await sb
      .from('progress')
      .select('episode')
      .eq('user_id',   session.user.id)
      .eq('tmdb_id',   Number(tmdbId))
      .eq('media_type','tv')
      .eq('season',    Number(season))
      .eq('watched',   true);
    for (const r of data || []) out.add(r.episode);
  } catch (e) {
    console.warn('watchedEpisodesForSeason:', e.message);
  }
  return out;
}

/* ───────────── LIKES (compteur public) ───────────── */

/**
 * Renvoie le nombre total de likes pour une œuvre (vue likes_counts).
 */
export async function likesCount(sb, tmdbId, mediaType) {
  if (!sb) return 0;
  try {
    const { data } = await sb
      .from('likes_counts')
      .select('n')
      .eq('tmdb_id',   Number(tmdbId))
      .eq('media_type', mediaType)
      .maybeSingle();
    return data?.n ?? 0;
  } catch {
    return 0;
  }
}
