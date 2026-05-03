// ════════════════════════════════════════
//  UI — SERVEURS / ACTIONS / ÉPISODES
// ════════════════════════════════════════
import { SERVERS, fetchImdbEmbeds, nexusExtensionInstalled } from './sources.js';
export const MOVIX_API = 'https://api.movix.cash';

// Cache simple (clé = `${type}:${id}:${s}:${e}`) pour éviter les fetches en
// double quand on ouvre/ferme le menu plusieurs fois.
const _imdbCache = new Map();

function cacheKey(type, id, s, e) {
  return `${type}:${id}:${s ?? 0}:${e ?? 0}`;
}

const ORIGIN_LABELS = {
  cinepro: 'CinePro', movix: 'CinePulse', cinepulse: 'CinePulse', rivestream: 'Rivestream',
  nightflix: 'Nightflix', imdb: 'IMDB', archive: 'Archive', user: 'Source',
};
const ORIGIN_COLORS = {
  cinepro: '#3b82f6', movix: '#10b981', cinepulse: '#10b981', rivestream: '#a855f7',
  nightflix: '#f59e0b', imdb: '#ec4899', archive: '#22c55e', user: '#888',
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function makeDropdown({ label, active }) {
  const det = document.createElement('details');
  det.className = `server-dropdown${active ? ' active' : ''}`;
  det.style.cssText = 'position:relative;display:inline-block';
  const sum = document.createElement('summary');
  sum.className = `server-btn${active ? ' active' : ''}`;
  sum.style.cssText = 'cursor:pointer;list-style:none;user-select:none';
  sum.innerHTML = `${label} <span style="opacity:.6">▾</span>`;
  det.appendChild(sum);
  const menu = document.createElement('div');
  menu.className = 'server-dropdown-menu';
  menu.style.cssText = `
    position:absolute;top:calc(100% + 4px);left:0;z-index:50;
    background:#111;border:1px solid #333;border-radius:.5rem;
    box-shadow:0 8px 24px rgba(0,0,0,.6);
    display:flex;flex-direction:column;min-width:240px;max-width:380px;
    max-height:60vh;overflow-y:auto;padding:.3rem;
  `;
  det.appendChild(menu);
  return { det, sum, menu };
}

function makeMenuItem({ html, active = false, onClick }) {
  const item = document.createElement('button');
  item.className = `server-btn-item${active ? ' active' : ''}`;
  item.innerHTML = html;
  item.style.cssText = `
    text-align:left;background:${active ? '#1a3a5f' : 'transparent'};
    color:#eee;border:0;padding:.5rem .8rem;border-radius:.3rem;
    cursor:pointer;font:500 .9rem system-ui,sans-serif;
    display:flex;align-items:center;gap:.55rem;width:100%;
  `;
  item.onmouseenter = () => { if (!active) item.style.background = '#222'; };
  item.onmouseleave = () => { if (!active) item.style.background = 'transparent'; };
  item.addEventListener('click', () => onClick(item));
  return item;
}

/**
 * Rend la barre de serveurs (un dropdown + 2 boutons simples + Nexus optionnel).
 *
 * langs = { hls?: string }
 * ctx   = { type, tmdbId, season, episode }
 */
export function renderServers({
  currentMode,
  currentServer,
  archiveSources,
  langs = {},
  ctx,
  onIframe,
  onMp4,
  onHls,
  onNexus,
}) {
  const sr = document.getElementById('servers-row');
  sr.innerHTML = '';

  // ─────────────────────────────────────────────
  // (1) Iframe ▾ : statiques + IMDB embeds dynamiques
  // ─────────────────────────────────────────────
  {
    const iframeActive = currentMode === 'iframe';
    const iframeLabel  = iframeActive ? `Iframe : ${currentServer}` : 'Iframe';
    const { det, menu } = makeDropdown({ label: iframeLabel, active: iframeActive });

    // Section statique
    const head1 = document.createElement('div');
    head1.textContent = 'Lecteurs';
    head1.style.cssText = 'color:#888;font:600 .68rem/1 system-ui;text-transform:uppercase;letter-spacing:.05em;padding:.5rem .8rem .25rem';
    menu.appendChild(head1);

    Object.keys(SERVERS).forEach((name) => {
      const isActive = iframeActive && name === currentServer;
      const item = makeMenuItem({
        html: `<span style="color:${ORIGIN_COLORS.user};font-size:1rem">▶</span><span>${escapeHtml(name)}</span>`,
        active: isActive,
        onClick: () => { det.removeAttribute('open'); onIframe(name); },
      });
      menu.appendChild(item);
    });

    // Section IMDB embeds (lazy, chargée au 1er open)
    const head2 = document.createElement('div');
    head2.textContent = 'Embeds IMDB';
    head2.style.cssText = 'color:#888;font:600 .68rem/1 system-ui;text-transform:uppercase;letter-spacing:.05em;padding:.7rem .8rem .25rem;border-top:1px solid #2a2a2a;margin-top:.4rem';
    menu.appendChild(head2);
    const placeholder = document.createElement('div');
    placeholder.textContent = '…chargement';
    placeholder.style.cssText = 'color:#666;padding:.5rem .8rem;font-size:.82rem;font-style:italic';
    menu.appendChild(placeholder);

    const loadImdb = async () => {
      const key = cacheKey(ctx.type, ctx.tmdbId, ctx.season, ctx.episode);
      let embeds = _imdbCache.get(key);
      if (!embeds) {
        embeds = await fetchImdbEmbeds(ctx.type, ctx.tmdbId, ctx.season, ctx.episode);
        _imdbCache.set(key, embeds);
      }
      placeholder.remove();
      if (!embeds.length) {
        const empty = document.createElement('div');
        empty.textContent = 'Aucun embed IMDB';
        empty.style.cssText = 'color:#666;padding:.5rem .8rem;font-size:.82rem;font-style:italic';
        menu.appendChild(empty);
        return;
      }
      embeds.forEach((emb) => {
        const color = emb.newTab ? ORIGIN_COLORS.movix : ORIGIN_COLORS.imdb;
        const tabIcon = emb.newTab ? ' <span title="Ouvre dans un nouvel onglet" style="font-size:.75rem;opacity:.6">⧉</span>' : '';
        const html = `<span style="width:8px;height:8px;border-radius:50%;background:${color};display:inline-block;flex:none"></span>
          <span style="flex:1;display:flex;flex-direction:column;gap:2px">
            <b>${escapeHtml(emb.label)}${tabIcon}</b>
            <small style="color:#888;font-weight:400">${escapeHtml(emb.language)}</small>
          </span>`;
        const item = makeMenuItem({
          html,
          onClick: () => {
            det.removeAttribute('open');
            if (emb.newTab) {
              window.open(emb.url, '_blank', 'noopener');
            } else {
              onIframe(`IMDB:${emb.label}`, emb.url);
            }
          },
        });
        menu.appendChild(item);
      });
    };

    let imdbLoaded = false;
    det.addEventListener('toggle', () => {
      if (det.open && !imdbLoaded) { imdbLoaded = true; loadImdb(); }
    });

    sr.appendChild(det);
  }

  // ─────────────────────────────────────────────
  // (2) Archive MP4 (bouton simple)
  // ─────────────────────────────────────────────
  if (archiveSources.length > 0) {
    const btn = document.createElement('button');
    btn.className = `server-btn archive${currentMode === 'mp4' ? ' active' : ''}`;
    btn.innerHTML = `▶ Archive MP4 <small style="opacity:.7">(${archiveSources.length})</small>`;
    btn.addEventListener('click', () => onMp4());
    sr.appendChild(btn);
  }

  // ─────────────────────────────────────────────
  // (3) CinePro (bouton simple, VO)
  // ─────────────────────────────────────────────
  {
    const btn = document.createElement('button');
    btn.className = `server-btn${currentMode === 'hls' ? ' active' : ''}`;
    const cineLang = langs.hls ? ` (${langs.hls})` : '';
    btn.innerHTML = `▶ CinePro${cineLang}`;
    btn.addEventListener('click', () => onHls());
    sr.appendChild(btn);
  }

  // ─────────────────────────────────────────────
  // (4) Nexus ⚡ — visible uniquement si l'extension Tampermonkey est détectée
  // ─────────────────────────────────────────────
  if (nexusExtensionInstalled() && typeof onNexus === 'function') {
    const btn = document.createElement('button');
    btn.className = `server-btn nexus${currentMode === 'nexus' ? ' active' : ''}`;
    btn.innerHTML = `⚡ Nexus`;
    btn.title = 'Extraction directe via l\'extension Turgot+';
    btn.addEventListener('click', () => onNexus());
    sr.appendChild(btn);
  }
}

export function renderActions({ session, inWl, inLk, isWatched, ICONS, onWl, onLk, onWo }) {
  const ar = document.getElementById('actions-row');
  if (!ar) return;
  ar.innerHTML = `
    <button class="action-btn ${inWl ? 'active-blue' : ''}" id="btn-wl">${inWl ? ICONS.check : ICONS.plus} ${inWl ? 'Dans ma liste' : 'Ma liste'}</button>
    <button class="action-btn ${isWatched ? 'active-green' : ''}" id="btn-wo">${ICONS.eye} ${isWatched ? 'Vu' : 'Marquer vu'}</button>
  `;
  document.getElementById('btn-wl').onclick = onWl;
  document.getElementById('btn-wo').onclick = onWo;
}

export function renderEpisodeNav({ type, season, episode, totalEpisodes, onChange, watchedSet }) {
  const row = document.getElementById('ep-nav-row');
  if (type !== 'tv') {
    row.classList.remove('visible');
    return;
  }
  row.classList.add('visible');
  const prev = document.getElementById('prev-ep');
  const next = document.getElementById('next-ep');
  const seenBadge = (watchedSet && watchedSet.has(episode)) ? ' ✓' : '';
  document.getElementById('ep-current').textContent = `S${season} · É${episode}${seenBadge}${totalEpisodes ? ` / ${totalEpisodes}` : ''}`;
  prev.disabled = episode <= 1;
  next.disabled = totalEpisodes > 0 && episode >= totalEpisodes;
  prev.onclick = () => onChange(-1);
  next.onclick = () => onChange(1);
}
