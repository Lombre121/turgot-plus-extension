// details.js

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';
import { SUPABASE_URL, SUPABASE_KEY, injectNav, ICONS } from './config.js';
import {
  loadProgress, lastWatchedEpisode, watchedEpisodesForSeason,
  markWatched, likesCount,
} from './prefs.js';
import { fetchMovixDownloads } from './sources.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const params = new URLSearchParams(location.search);
const id = params.get('id');
const type = params.get('type') || 'movie';

const TMDB = 'd40428d49744c5a2ba87bdad5d750538';

let session = null;
let pendingImageUrl = null;
let detailsData = null;
let resumeInfo = null;

/* ───────────── INIT ───────────── */

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const { data } = await sb.auth.getSession();
    session = data.session;
  } catch (_) {}

  try { injectNav('', session); } catch (_) {}

  await wireStaticButtons();
  loadDetails();
  refreshLikeCount();
});

/* ───────────── LOAD DETAILS ───────────── */

async function loadDetails() {
  if (!id) return;

  const res = await fetch(
    `https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB}&language=fr-FR&append_to_response=credits,videos,images,recommendations,release_dates,content_ratings&include_image_language=en,null,fr`
  );
  const data = await res.json();
  detailsData = data;

  const posterEl = document.getElementById('poster');
  if (posterEl && data.poster_path) {
    posterEl.src = `https://image.tmdb.org/t/p/w780${data.poster_path}`;
  }

  /* ─── DESKTOP HERO : backdrop sans texte + logo du film/série ─── */
  const dHero  = document.getElementById('hero-desktop');
  const dBg    = document.getElementById('hero-desktop-bg');
  const dLogo  = document.getElementById('hero-desktop-logo');
  const dTitle = document.getElementById('hero-desktop-title');
  const titleText = data.title || data.name || '';
  if (dTitle) dTitle.textContent = titleText;

  if (dBg) {
    const backdrops = data.images?.backdrops || [];
    const cleanBd = backdrops.find(b => b.iso_639_1 === null) || backdrops[0];
    const bdPath = cleanBd?.file_path || data.backdrop_path;
    if (bdPath) {
      dBg.src = `https://image.tmdb.org/t/p/original${bdPath}`;
    } else if (dHero) {
      dHero.style.display = 'none';
    }
  }

  if (dLogo) {
    const logos = data.images?.logos || [];
    const logo = logos.find(l => l.iso_639_1 === 'en')
              || logos.find(l => l.iso_639_1 === null)
              || logos.find(l => l.iso_639_1 === 'fr')
              || logos[0];
    if (logo) {
      dLogo.src = `https://image.tmdb.org/t/p/w500${logo.file_path}`;
      dLogo.hidden = false;
      if (dTitle) dTitle.style.display = 'none';
    }
  }

  const titleEl = document.getElementById('title');
  if (titleEl) titleEl.textContent = titleText;

  const originalTitleEl = document.getElementById('original-title');
  if (originalTitleEl) {
    originalTitleEl.textContent = data.original_title || data.original_name || '';
  }

  const ratingEl = document.getElementById('rating');
  if (ratingEl) {
    ratingEl.textContent = data.vote_average ? `⭐ ${data.vote_average.toFixed(1)}` : '';
  }

  const runtimeEl = document.getElementById('runtime');
  if (runtimeEl) {
    runtimeEl.textContent = data.runtime ? `${data.runtime} min` : '';
  }

  const certifEl = document.getElementById('certif');
  if (certifEl) {
    let certif = '';
    if (type === 'movie') {
      const results = data.release_dates?.results || [];
      const pick = results.find(r => r.iso_3166_1 === 'FR')
                || results.find(r => r.iso_3166_1 === 'US')
                || results.find(r => r.iso_3166_1 === 'GB');
      const rels = pick?.release_dates || [];
      certif = rels.map(r => (r.certification || '').trim()).find(c => c) || '';
    } else {
      const results = data.content_ratings?.results || [];
      const pick = results.find(r => r.iso_3166_1 === 'FR')
                || results.find(r => r.iso_3166_1 === 'US')
                || results.find(r => r.iso_3166_1 === 'GB');
      certif = (pick?.rating || '').trim();
    }
    if (!certif && data.adult) certif = '18+';
    const numMatch = certif.match(/^\+?(\d{1,2})\+?$/);
    if (numMatch) certif = `+${numMatch[1]} ans`;
    certifEl.textContent = certif;
    certifEl.style.display = certif ? '' : 'none';
  }

  const genresDiv = document.getElementById('genres');
  if (genresDiv) {
    genresDiv.innerHTML = '';
    (data.genres || []).forEach(g => {
      const span = document.createElement('span');
      span.textContent = g.name;
      genresDiv.appendChild(span);
    });
  }

  const overviewEl = document.getElementById('overview');
  if (overviewEl) {
    overviewEl.textContent = data.overview || 'Aucune description disponible.';
  }

  loadCast(data);
  loadTrailer(data);
  loadInfos(data);
  loadImages(data);
  loadRecommendations(data);

  if (type === 'tv') {
    await loadSeasons(data);
  }

  await refreshResumeInfo();
}

/* ───────────── REPRENDRE ───────────── */

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}

async function refreshResumeInfo() {
  resumeInfo = null;
  if (!session) { setPlayLabel('Regarder'); return; }
  if (type === 'movie') {
    const p = await loadProgress(sb, session, id, 'movie');
    if (p && p.duration > 0 && p.position > 20 && p.position / p.duration < 0.95) {
      resumeInfo = { position: p.position, duration: p.duration, resume: true };
      setPlayLabel(`Reprendre — ${fmtTime(p.position)} / ${fmtTime(p.duration)}`);
    } else {
      setPlayLabel('Regarder');
    }
  } else {
    const last = await lastWatchedEpisode(sb, session, id);
    if (last) {
      resumeInfo = { season: last.season, episode: last.episode, position: last.position || 0, duration: last.duration || 0, resume: !!last.resume, next: !!last.next };
      const label = last.resume
        ? `Reprendre S${last.season}É${last.episode}${last.duration ? ' — ' + fmtTime(last.position) + ' / ' + fmtTime(last.duration) : ''}`
        : `Continuer S${last.season}É${last.episode}`;
      setPlayLabel(label);
    } else {
      setPlayLabel('Regarder');
    }
  }
}

function setPlayLabel(text) {
  const playBtn = document.getElementById('play-btn');
  if (!playBtn) return;
  playBtn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
    ${text}`;
}

/* ───────────── CAST ───────────── */

function loadCast(data) {
  const castDiv = document.getElementById('cast');
  if (!castDiv) return;
  castDiv.innerHTML = '';
  const cast = data.credits?.cast || [];
  cast
    .filter(a => a.profile_path)
    .slice(0, 12)
    .forEach(actor => {
      const div = document.createElement('div');
      div.className = 'cast-item';
      div.innerHTML = `
        <img src="https://image.tmdb.org/t/p/w185${actor.profile_path}" alt="${actor.name}">
        <p>${actor.name}</p>
      `;
      castDiv.appendChild(div);
    });
}

/* ───────────── TRAILER ───────────── */

function loadTrailer(data) {
  const trailerDiv = document.getElementById('trailer');
  if (!trailerDiv) return;
  trailerDiv.innerHTML = '';
  const trailer = data.videos?.results?.find(
    v => v.type === 'Trailer' && v.site === 'YouTube'
  );
  if (!trailer) return;
  trailerDiv.innerHTML = `
    <iframe src="https://www.youtube.com/embed/${trailer.key}" allowfullscreen></iframe>
  `;
}

/* ───────────── INFOS ───────────── */

function loadInfos(data) {
  const div = document.getElementById('infos');
  if (!div) return;
  div.innerHTML = `
    <div><strong>Date de sortie :</strong> ${data.release_date || data.first_air_date || '—'}</div>
    <div><strong>Statut :</strong> ${data.status || '—'}</div>
    <div><strong>Budget :</strong> ${data.budget ? data.budget.toLocaleString() + ' $' : 'Non communiqué'}</div>
    <div><strong>Revenus :</strong> ${data.revenue ? data.revenue.toLocaleString() + ' $' : 'Non communiqué'}</div>
  `;
  if (data.production_companies?.length) {
    div.innerHTML += `<div><strong>Sociétés :</strong> ${data.production_companies.map(c => c.name).join(', ')}</div>`;
  }
  if (data.production_countries?.length) {
    div.innerHTML += `<div><strong>Pays :</strong> ${data.production_countries.map(c => c.name).join(', ')}</div>`;
  }
  if (data.spoken_languages?.length) {
    div.innerHTML += `<div><strong>Langues :</strong> ${data.spoken_languages.map(l => l.english_name).join(', ')}</div>`;
  }
}

/* ───────────── IMAGES + CARROUSEL + DL ───────────── */

function loadImages(data) {
  const track = document.getElementById('images');
  if (!track) return;
  track.innerHTML = '';
  const posters = data.images?.posters?.slice(0, 12) || [];
  posters.forEach(img => {
    const original = `https://image.tmdb.org/t/p/original${img.file_path}`;
    const item = document.createElement('div');
    item.className = 'image-item-wrap';
    item.innerHTML = `
      <img class="image-item" src="https://image.tmdb.org/t/p/w500${img.file_path}" alt="">
      <button class="image-download-btn" data-url="${original}">
        <svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M5 20h14v-2H5m14-9h-4V3H9v6H5l7 7 7-7z"/></svg>
      </button>
    `;
    track.appendChild(item);
  });

  track.addEventListener('click', e => {
    const btn = e.target.closest('.image-download-btn');
    if (!btn) return;
    pendingImageUrl = btn.dataset.url;
    const cm = document.getElementById('confirm-modal');
    if (cm) cm.classList.remove('hidden');
  });

  const confirmNo = document.getElementById('confirm-no');
  const confirmYes = document.getElementById('confirm-yes');
  if (confirmNo) {
    confirmNo.onclick = () => {
      const cm = document.getElementById('confirm-modal');
      if (cm) cm.classList.add('hidden');
      pendingImageUrl = null;
    };
  }
  if (confirmYes) {
    confirmYes.onclick = () => {
      if (pendingImageUrl) window.open(pendingImageUrl, '_blank');
      const cm = document.getElementById('confirm-modal');
      if (cm) cm.classList.add('hidden');
      pendingImageUrl = null;
    };
  }

  const trackEl = document.querySelector('.images-track');
  const prevBtn = document.getElementById('carousel-prev');
  const nextBtn = document.getElementById('carousel-next');
  if (trackEl && prevBtn && nextBtn) {
    prevBtn.onclick = () => trackEl.scrollBy({ left: -trackEl.clientWidth * 0.7, behavior: 'smooth' });
    nextBtn.onclick = () => trackEl.scrollBy({ left:  trackEl.clientWidth * 0.7, behavior: 'smooth' });
  }
}

/* ───────────── RECOMMANDATIONS ───────────── */

function loadRecommendations(data) {
  const div = document.getElementById('reco');
  if (!div) return;
  div.innerHTML = '';
  const recos = data.recommendations?.results?.slice(0, 12) || [];
  recos.forEach(r => {
    const a = document.createElement('a');
    a.className = 'reco-item';
    a.href = `details.html?id=${r.id}&type=${r.media_type || type}`;
    a.innerHTML = `
      <img src="https://image.tmdb.org/t/p/w300${r.poster_path}" alt="">
      <p>${r.title || r.name}</p>
    `;
    div.appendChild(a);
  });
}

/* ───────────── SAISONS + ÉPISODES (TV) — MENU DÉROULANT ───────────── */

let currentSeasonNumber = null;
let currentSeasonWatched = new Set();
let episodesListenerWired = false;

async function loadSeasons(data) {
  const block   = document.getElementById('seasons-block');
  const menu    = document.getElementById('season-menu');
  const current = document.getElementById('season-current');
  const btn     = document.getElementById('season-btn');

  if (!block || !menu || !current || !btn) return;

  const seasons = (data.seasons || []).filter(s => s.season_number > 0);
  if (seasons.length === 0) return;

  block.style.display = 'block';
  menu.innerHTML = '';

  const closeMenu = () => { menu.classList.remove('show'); btn.setAttribute('aria-expanded', 'false'); };
  const openMenu  = () => { menu.classList.add('show');    btn.setAttribute('aria-expanded', 'true'); };

  seasons.forEach(s => {
    const li = document.createElement('li');
    li.textContent = "Saison " + s.season_number;
    li.setAttribute('role', 'option');
    li.dataset.season = s.season_number;
    li.addEventListener('click', () => {
      current.textContent = s.season_number;
      closeMenu();
      loadEpisodes(s.season_number);
    });
    menu.appendChild(li);
  });

  let defaultSeason = seasons[0].season_number;
  if (resumeInfo?.season && seasons.find(s => s.season_number === resumeInfo.season)) {
    defaultSeason = resumeInfo.season;
  }
  current.textContent = defaultSeason;
  await loadEpisodes(defaultSeason);

  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (menu.classList.contains('show')) closeMenu();
    else openMenu();
  });

  document.addEventListener('click', e => {
    if (!menu.contains(e.target) && e.target !== btn) closeMenu();
  });
}

async function loadEpisodes(seasonNumber) {
  currentSeasonNumber = seasonNumber;
  currentSeasonWatched = await watchedEpisodesForSeason(sb, session, id, seasonNumber);

  const res = await fetch(
    "https://api.themoviedb.org/3/tv/" + id + "/season/" + seasonNumber + "?api_key=" + TMDB + "&language=fr-FR"
  );
  const data = await res.json();

  const block = document.getElementById('episodes-block');
  const list = document.getElementById('episodes');
  if (!block || !list) return;

  block.style.display = 'block';
  list.innerHTML = '';

  let progByEp = new Map();
  if (session) {
    try {
      const { data: prog } = await sb.from('progress')
        .select('episode,position,duration,watched')
        .eq('user_id', session.user.id)
        .eq('tmdb_id', Number(id))
        .eq('media_type', 'tv')
        .eq('season', Number(seasonNumber));
      for (const r of prog || []) progByEp.set(r.episode, r);
    } catch {}
  }

  (data.episodes || []).forEach(ep => {
    const still = ep.still_path ? "https://image.tmdb.org/t/p/w300" + ep.still_path : "";
    const dlLink = "https://vidvault.ru/tv/" + id + "/" + seasonNumber + "/" + ep.episode_number;

    const isSeen = currentSeasonWatched.has(ep.episode_number);
    const prog = progByEp.get(ep.episode_number);
    const ratio = prog && prog.duration > 0 ? Math.min(100, (prog.position / prog.duration) * 100) : 0;
    const showBar = ratio > 2 && ratio < 95;

    const card = document.createElement('div');
    card.className = 'episode-card' + (isSeen ? ' seen' : '');
    card.dataset.episode = ep.episode_number;

    card.innerHTML = `
      <div class="episode-thumb">
        <img src="${still}" alt="">
        ${isSeen ? `<span class="ep-badge ep-badge-seen" title="Vu">✓</span>` : ''}
        <button class="episode-dl-btn"
                data-vidvault="${dlLink}"
                data-tmdb="${id}" data-season="${seasonNumber}" data-episode="${ep.episode_number}"
                data-title="${(detailsData?.name || '').replace(/"/g,'&quot;')} S${seasonNumber}É${ep.episode_number}">
          <svg width="12" height="12" viewBox="0 0 24 24">
            <path fill="currentColor" d="M5 20h14v-2H5m14-9h-4V3H9v6H5l7 7 7-7z"/>
          </svg>
          Télécharger
        </button>
        ${showBar ? `<div class="ep-progress"><span style="width:${ratio.toFixed(1)}%"></span></div>` : ''}
      </div>

      <div class="episode-info">
        <div class="episode-title">${ep.episode_number}. ${ep.name}</div>
        <div class="episode-runtime">${ep.runtime || "?"} min</div>
        <div class="episode-overview">${ep.overview || "Aucun synopsis."}</div>
        <button class="ep-seen-toggle ${isSeen ? 'seen' : ''}"
                data-ep="${ep.episode_number}"
                data-season="${seasonNumber}"
                title="${isSeen ? 'Marquer non vu' : 'Marquer comme vu'}">
          ${isSeen ? '✓ Vu' : '○ Marquer vu'}
        </button>
      </div>
    `;

    list.appendChild(card);
  });

  if (!episodesListenerWired) {
    episodesListenerWired = true;

    list.addEventListener('click', async e => {
      const dl = e.target.closest('.episode-dl-btn');
      if (dl) {
        e.stopPropagation();
        openDownloadModal({
          vidvault: dl.dataset.vidvault,
          tmdb:     dl.dataset.tmdb,
          season:   parseInt(dl.dataset.season),
          episode:  parseInt(dl.dataset.episode),
          title:    dl.dataset.title || '',
          mediaType:'tv',
        });
        return;
      }

      const toggleBtn = e.target.closest('.ep-seen-toggle');
      if (toggleBtn) {
        e.stopPropagation();
        if (!session) { location.href = 'connexion.html'; return; }
        const epNum  = parseInt(toggleBtn.dataset.ep);
        const sNum   = parseInt(toggleBtn.dataset.season);
        const nowSeen = toggleBtn.classList.contains('seen');
        const nextSeen = !nowSeen;
        try {
          await markWatched(sb, session, { tmdbId: id, mediaType: 'tv', season: sNum, episode: epNum, watched: nextSeen });
        } catch(err) { console.warn('[toggle vu]', err); }
        await loadEpisodes(sNum);
        await refreshResumeInfo();
        return;
      }

      const card = e.target.closest('.episode-card');
      if (card && card.dataset.episode) {
        location.href = "video.html?id=" + id + "&type=tv&season=" + currentSeasonNumber + "&episode=" + card.dataset.episode;
      }
    });
  }
}

/* ───────────── LIKES (compteur public) ───────────── */

async function refreshLikeCount() {
  const el = document.getElementById('like-count');
  if (!el) return;
  const n = await likesCount(sb, id, type);
  el.textContent = n > 0 ? n.toString() : '';
}

/* ───────────── BOUTONS STATIQUES ───────────── */

async function wireStaticButtons() {
  const playBtn  = document.getElementById('play-btn');
  const downloadBtn = document.getElementById('download-btn');
  const listBtn  = document.getElementById('list-btn');
  const seenBtn  = document.getElementById('seen-btn');
  const likeBtn  = document.getElementById('like-btn');
  const shareBtn = document.getElementById('share-btn');

  if (playBtn) {
    playBtn.onclick = () => {
      if (type === "tv") {
        const s = resumeInfo?.season  ?? 1;
        const e = resumeInfo?.episode ?? 1;
        location.href = `video.html?id=${id}&type=tv&season=${s}&episode=${e}`;
      } else {
        location.href = `video.html?id=${id}&type=movie`;
      }
    };
  }

  if (downloadBtn) {
    downloadBtn.onclick = () => {
      openDownloadModal({
        vidvault: `https://vidvault.ru/movie/${id}`,
        tmdb: id, mediaType: 'movie',
        title: (detailsData?.title || ''),
      });
    };
  }

  if (listBtn) {
    let inList = false;
    if (session) {
      const { data: wlData } = await sb.from("watchlist")
        .select("id")
        .eq("user_id", session.user.id)
        .eq("tmdb_id", parseInt(id))
        .eq("media_type", type)
        .maybeSingle();
      inList = !!wlData;
      if (inList) listBtn.innerHTML = `${ICONS.check} Ajouté`;
    }

    listBtn.onclick = async () => {
      if (!session) { location.href = "connexion.html"; return; }
      if (inList) {
        await sb.from("watchlist").delete()
          .eq("user_id", session.user.id)
          .eq("tmdb_id", parseInt(id))
          .eq("media_type", type);
        inList = false;
        listBtn.innerHTML = `${ICONS.plus} Ma liste`;
      } else {
        const t = (detailsData && (detailsData.title || detailsData.name)) || (document.getElementById('title')?.textContent || '');
        const p = detailsData && detailsData.poster_path ? detailsData.poster_path : null;
        await sb.from("watchlist").upsert({
          user_id: session.user.id,
          tmdb_id: parseInt(id),
          media_type: type,
          title: t, poster: p, watched: false,
          added_at: new Date().toISOString(),
        });
        inList = true;
        listBtn.innerHTML = `${ICONS.check} Ajouté`;
      }
    };
  }

  if (seenBtn) {
    let isSeen = false;
    if (session) {
      const p = await loadProgress(sb, session, id, type, 0, 0);
      isSeen = !!p?.watched;
    }
    const apply = () => {
      if (isSeen) { seenBtn.classList.add("btn-blue"); seenBtn.classList.remove("btn-ghost"); }
      else        { seenBtn.classList.remove("btn-blue"); seenBtn.classList.add("btn-ghost"); }
    };
    apply();
    seenBtn.onclick = async () => {
      if (!session) { location.href = "connexion.html"; return; }
      isSeen = !isSeen;
      apply();
      if (type === 'movie') {
        await markWatched(sb, session, { tmdbId: id, mediaType: 'movie', season: 0, episode: 0, watched: isSeen });
      } else {
        await markWatched(sb, session, { tmdbId: id, mediaType: 'tv', season: 0, episode: 0, watched: isSeen });
        await refreshResumeInfo();
      }
    };
  }

  if (likeBtn) {
    let isLiked = false;
    if (session) {
      const { data: lk } = await sb.from('likes')
        .select('id')
        .eq('user_id', session.user.id)
        .eq('tmdb_id', parseInt(id))
        .eq('media_type', type)
        .maybeSingle();
      isLiked = !!lk;
    }
    const apply = () => {
      if (isLiked) { likeBtn.classList.add('liked'); }
      else         { likeBtn.classList.remove('liked'); }
    };
    apply();
    likeBtn.onclick = async () => {
      if (!session) { location.href = "connexion.html"; return; }
      isLiked = !isLiked;
      apply();
      try {
        if (isLiked) {
          await sb.from('likes').upsert({
            user_id: session.user.id,
            tmdb_id: parseInt(id),
            media_type: type,
            title: detailsData?.title || detailsData?.name || '',
            poster: detailsData?.poster_path || null,
            liked_at: new Date().toISOString(),
          });
        } else {
          await sb.from('likes').delete()
            .eq('user_id', session.user.id)
            .eq('tmdb_id', parseInt(id))
            .eq('media_type', type);
        }
      } catch (e) { console.warn(e); }
      refreshLikeCount();
    };
  }

  if (shareBtn) {
    shareBtn.onclick = async () => {
      const url = window.location.href;
      const title = (document.getElementById("title")?.textContent || "Turgot+").trim();
      if (navigator.share) {
        try { await navigator.share({ title, url }); } catch (_) {}
      } else {
        await navigator.clipboard.writeText(url);
        alert("Lien de la page copié !");
      }
    };
  }

  document.getElementById('close-modal')?.addEventListener('click', () => {
    document.getElementById('download-modal')?.classList.add('hidden');
  });
}

/* ───────────── MODAL TÉLÉCHARGEMENT (vidvault + movix) ───────────── */

async function openDownloadModal({ vidvault, tmdb, mediaType = 'movie', season, episode, title }) {
  const modal = document.getElementById('download-modal');
  if (!modal) return;
  modal.classList.remove('hidden');

  const vidvaultBtn = document.getElementById('dl-vidvault');
  const vidvaultLink = document.getElementById('dl-vidvault-link');
  if (vidvaultBtn) {
    vidvaultBtn.onclick = () => { if (vidvault) window.open(vidvault, '_blank'); };
  }
  if (vidvaultLink) vidvaultLink.value = vidvault || '';

  const qBox = document.getElementById('dl-qualities');
  if (qBox) {
    qBox.innerHTML = '<div class="dl-loading">⏳ Recherche des fichiers téléchargeables...</div>';
    try {
      const movixSources = await fetchMovixDownloads(mediaType, String(tmdb), season, episode);

      if (!movixSources.length) {
        qBox.innerHTML = '<div class="dl-empty">Aucun fichier disponible pour le moment.</div>';
      } else {
        qBox.innerHTML = '';

        const head = document.createElement('div');
        head.style.cssText = 'color:#10b981;font:600 .72rem system-ui;text-transform:uppercase;letter-spacing:.05em;padding:.4rem .6rem .2rem';
        head.textContent = 'CinePulse Premium';
        qBox.appendChild(head);

        movixSources.forEach(d => {
          const item = document.createElement('a');
          item.className = 'dl-quality-item';
          item.href = d.url; item.target = '_blank'; item.rel = 'noopener';
          item.innerHTML = `
            <span class="dl-q-origin" style="background:#10b981">movix</span>
            <span class="dl-q-info"><b>${d.quality}</b><small>${d.label}</small></span>
            <span class="dl-q-action">⬇ DL</span>`;
          qBox.appendChild(item);
        });
      }
    } catch (e) {
      qBox.innerHTML = `<div class="dl-empty">Erreur : ${e.message}</div>`;
    }
  }
}
