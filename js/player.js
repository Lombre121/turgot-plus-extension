// ════════════════════════════════════════
//  CUSTOM PLAYER — HLS / MP4 multi-sources
//  Sources hétérogènes (origine, langue, provider, qualité, ms) gérées
//  directement par le menu "Qualité" (qui devient un sélecteur de SOURCES).
//  Reprise + sauvegarde de progression Supabase, prefs persistées.
// ════════════════════════════════════════

import { savePrefs, saveProgress, flushProgress, DEFAULT_PREFS } from './prefs.js';

const ORIGIN_LABELS = {
  cinepro:    'CinePro',
  movix:      'CinePulse',
  cinepulse:  'CinePulse',
  rivestream: 'Rivestream',
  nightflix:  'Nightflix',
  imdb:       'IMDB',
  archive:    'Archive',
  user:       'Source',
};
const ORIGIN_COLORS = {
  cinepro:    '#3b82f6',
  movix:      '#10b981',
  cinepulse:  '#10b981',
  rivestream: '#a855f7',
  nightflix:  '#f59e0b',
  imdb:       '#ec4899',
  archive:    '#22c55e',
  user:       '#888888',
};

export class CustomPlayer {
  /**
   * @param {HTMLElement} wrap
   * @param {Array} sources - [{ url, isHls?, format?, quality?, origin?, language?, label?, ms?, caption? }, ...]
   * @param {Object} ctx
   *   - tmdbId, type, season, episode, originalLang, title
   *   - sb, session, prefs (préférences déjà chargées par video.js)
   *   - resume: { position, duration } | null
   *   - onSwitchSource: (idx) => void  (callback informatif après switch manuel)
   *   - onProgress: ({ position, duration, watched }) => void
   */
  constructor(wrap, sources, ctx = {}) {
    this.wrap = wrap;
    this.ctx  = ctx;
    this.sb       = ctx.sb || null;
    this.session  = ctx.session || null;
    this.prefs    = { ...DEFAULT_PREFS, ...(ctx.prefs || {}) };
    this.resume   = ctx.resume || null;

    this.sources = (sources || []).map((s, i) => ({
      url:      s.url,
      isHls:    s.isHls ?? (s.format === 'hls' || (typeof s.url === 'string' && s.url.includes('.m3u8'))),
      format:   s.format || (s.isHls ? 'hls' : 'mp4'),
      quality:  s.quality || 'Auto',
      origin:   s.origin   || 'user',
      language: s.language || null,
      label:    s.label    || null,
      ms:       s.ms       ?? null,
      caption:  s.caption  || null,
      _idx:     i,
    }));
    if (!this.sources.length) {
      throw new Error('CustomPlayer: aucune source fournie');
    }

    // Choix initial : préférence user (origin+lang) si match, sinon 1ʳᵉ
    this.currentIdx = this._pickInitial();
    this.subtitleCues = [];
    this.subtitleStyle = {
      size:      this.prefs.subSize,
      color:     this.prefs.subColor,
      bg:        'rgba(0,0,0,0.55)',
      bgEnabled: this.prefs.subBg,
      bottom:    this.prefs.subBottom,
    };
    this.audioCtx = null;
    this.gainNode = null;
    this.hideTimer = null;
    this._lastProgressSave = 0;
    this._didResume = false;

    this.render();
    this.applyPrefsToUi();
    this.setupAudio();
    this.attachVideoEvents();
    this.attachUiEvents();
    this.attachLifecycle();

    const src = this.sources[this.currentIdx];
    this.loadSrc(src, false);
  }

  _pickInitial() {
    const { preferredOrigin, preferredLang } = this.prefs;
    if (preferredOrigin || preferredLang) {
      // 1) match origine + langue
      let i = this.sources.findIndex(s =>
        (!preferredOrigin || s.origin === preferredOrigin) &&
        (!preferredLang   || s.language === preferredLang));
      if (i >= 0) return i;
      // 2) match langue seule
      if (preferredLang) {
        i = this.sources.findIndex(s => s.language === preferredLang);
        if (i >= 0) return i;
      }
      // 3) match origine seule
      if (preferredOrigin) {
        i = this.sources.findIndex(s => s.origin === preferredOrigin);
        if (i >= 0) return i;
      }
    }
    return 0;
  }

  /* ───────────── RENDER ───────────── */

  render() {
    const cur = this.sources[this.currentIdx];
    this.wrap.innerHTML = `
      <div class="cp" tabindex="0">
        <video class="cp-video" preload="metadata" playsinline></video>
        <div class="cp-subs-render" style="display:none"></div>
        <div class="cp-loader"></div>
        <div class="cp-bigplay" tabindex="0">
          <svg viewBox="0 0 24 24" fill="white"><polygon points="5,3 22,12 5,21"/></svg>
        </div>
        <div class="cp-controls">
          <div class="cp-seek-row">
            <span class="cp-time" id="cp-time-cur">0:00</span>
            <input type="range" class="cp-seek" min="0" max="100" value="0" step="0.1" tabindex="0" aria-label="Progression">
            <span class="cp-time" id="cp-time-tot">0:00</span>
          </div>
          <div class="cp-bot">
            <button class="cp-btn cp-play" tabindex="0" title="Lecture (Espace)">
              <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 22,12 5,21"/></svg>
            </button>
            <button class="cp-btn cp-prev cp-extra" tabindex="0" title="Reculer 10s">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 19l-9-7 9-7v14z"/><path d="M22 19l-9-7 9-7v14z"/></svg>
            </button>
            <button class="cp-btn cp-fwd cp-extra" tabindex="0" title="Avancer 10s">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 5l9 7-9 7V5z"/><path d="M2 5l9 7-9 7V5z"/></svg>
            </button>
            <span class="cp-vol-wrap cp-extra">
              <button class="cp-btn cp-mute" tabindex="0" title="Muet (M)">
                <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 12c0-1.77-1-3.29-2.5-4.03v8.06c1.5-.75 2.5-2.26 2.5-4.03z" fill="currentColor"/></svg>
              </button>
              <input type="range" class="cp-vol" min="0" max="1" step="0.01" value="${this.prefs.volume}" tabindex="0" aria-label="Volume">
            </span>
            <span class="cp-spacer"></span>
            <button class="cp-btn cp-quality has-text cp-extra" tabindex="0" title="Sources / Qualité">${this._currentLabel(cur)}</button>
            <button class="cp-btn cp-subs cp-extra" tabindex="0" title="Sous-titres">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><line x1="7" y1="15" x2="11" y2="15"/><line x1="14" y1="15" x2="17" y2="15"/><line x1="7" y1="11" x2="9" y2="11"/><line x1="12" y1="11" x2="17" y2="11"/></svg>
            </button>
            <button class="cp-btn cp-settings cp-extra" tabindex="0" title="Paramètres">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.36.16.74.32 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
            <button class="cp-btn cp-stretch cp-extra" tabindex="0" title="Adapter / Remplir">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h6v2H6v4H4V4zM14 4h6v6h-2V6h-4V4zM4 20v-6h2v4h4v2H4zM20 20h-6v-2h4v-4h2v6z"/></svg>
            </button>
            <button class="cp-btn cp-fs" tabindex="0" title="Plein écran (F)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
            </button>
          </div>
        </div>

        <!-- MENU SOURCES (anciennement "Qualité") -->
        <div class="cp-menu cp-menu-quality" hidden>
          <h4>Sources disponibles (${this.sources.length})</h4>
          <div class="cp-src-list">${this._renderSourcesList()}</div>
        </div>

        <!-- MENU SOUS-TITRES -->
        <div class="cp-menu cp-menu-subs" hidden>
          <h4>Sous-titres</h4>
          <button class="cp-menu-item active" data-action="subs-off">Désactivés</button>
          <div class="cp-subs-langs"></div>
          <hr>
          <h4>Charger</h4>
          <label class="cp-file-input">Fichier .srt / .vtt
            <input type="file" accept=".srt,.vtt,text/vtt,text/plain" id="cp-subs-file">
          </label>
          <div class="cp-menu-row">
            <input type="text" placeholder="URL .srt ou .vtt" id="cp-subs-url" style="flex:1">
            <button class="cp-menu-item" id="cp-subs-url-load" style="padding:5px 10px">OK</button>
          </div>
          <a class="cp-menu-item" href="https://www.opensubtitles.com/fr/search/sublanguageid-fr/moviename-${encodeURIComponent(this.ctx.title || '')}" target="_blank" rel="noopener">Chercher sur OpenSubtitles ↗</a>
          <hr>
          <h4>Style</h4>
          <div class="cp-menu-row"><label>Taille</label><input type="range" min="14" max="40" value="${this.prefs.subSize}" id="cp-st-size"></div>
          <div class="cp-menu-row"><label>Couleur</label><input type="color" value="${this.prefs.subColor}" id="cp-st-color"></div>
          <div class="cp-menu-row"><label>Fond</label><input type="checkbox" id="cp-st-bg"${this.prefs.subBg ? ' checked' : ''}></div>
          <div class="cp-menu-row"><label>Position bas (%)</label><input type="range" min="2" max="40" value="${this.prefs.subBottom}" id="cp-st-bottom"></div>
        </div>

        <!-- MENU PARAMÈTRES -->
        <div class="cp-menu cp-menu-settings" hidden>
          <h4>Image</h4>
          <div class="cp-menu-row"><label>Luminosité</label><input type="range" min="0.5" max="2" step="0.01" value="${this.prefs.bright}"   id="cp-fx-bright"></div>
          <div class="cp-menu-row"><label>Contraste</label> <input type="range" min="0.5" max="2" step="0.01" value="${this.prefs.contrast}" id="cp-fx-contrast"></div>
          <div class="cp-menu-row"><label>Saturation</label><input type="range" min="0"   max="2" step="0.01" value="${this.prefs.sat}"      id="cp-fx-sat"></div>
          <hr>
          <h4>Son</h4>
          <div class="cp-menu-row"><label>Volume boost</label><input type="range" min="1" max="3" step="0.1" value="${this.prefs.gain}" id="cp-fx-gain"></div>
          <div class="cp-menu-row"><label>Vitesse</label>
            <select id="cp-fx-speed">
              <option value="0.5">0.5x</option><option value="0.75">0.75x</option>
              <option value="1">1x</option><option value="1.25">1.25x</option>
              <option value="1.5">1.5x</option><option value="2">2x</option>
            </select>
          </div>
          <hr>
          <button class="cp-menu-item" id="cp-fx-reset">↺ Réinitialiser image</button>
        </div>
      </div>
    `;

    this.cp        = this.wrap.querySelector('.cp');
    this.video     = this.wrap.querySelector('.cp-video');
    this.subsRender= this.wrap.querySelector('.cp-subs-render');
    this.bigPlay   = this.wrap.querySelector('.cp-bigplay');
    this.seek      = this.wrap.querySelector('.cp-seek');
    this.timeCur   = this.wrap.querySelector('#cp-time-cur');
    this.timeTot   = this.wrap.querySelector('#cp-time-tot');
    this.btnPlay   = this.wrap.querySelector('.cp-play');
    this.btnMute   = this.wrap.querySelector('.cp-mute');
    this.vol       = this.wrap.querySelector('.cp-vol');
    this.qualityBtn= this.wrap.querySelector('.cp-quality');
    this.menuQ     = this.wrap.querySelector('.cp-menu-quality');
    this.menuS     = this.wrap.querySelector('.cp-menu-subs');
    this.menuSet   = this.wrap.querySelector('.cp-menu-settings');

    if (this.prefs.fitCover) this.cp.classList.add('fit-cover');
  }

  _currentLabel(src) {
    if (!src) return '?';
    const parts = [];
    if (src.origin && src.origin !== 'user') parts.push(ORIGIN_LABELS[src.origin] || src.origin);
    if (src.language) parts.push(src.language);
    parts.push(src.quality || 'Auto');
    return parts.join(' · ');
  }

  _renderSourcesList() {
    return this.sources.map((s, i) => {
      const color = ORIGIN_COLORS[s.origin] || '#888';
      const isActive = i === this.currentIdx;
      const lang = s.language ? `<span class="cp-src-lang">${escapeHtml(s.language)}</span>` : '';
      const provider = s.label ? ` · ${escapeHtml(s.label)}` : '';
      const ms = s.ms != null ? `<span class="cp-src-ms">${s.ms}ms</span>` : '';
      const fluxBadge = s.caption ? `<span class="cp-src-badge cp-src-badge-flux" title="Sous-titres inclus dans le flux">Flux</span>` : '';
      return `
        <button class="cp-menu-item cp-src-item${isActive ? ' active' : ''}" data-idx="${i}">
          <span class="cp-src-dot" style="background:${color}"></span>
          <span class="cp-src-main">
            <b>${escapeHtml(ORIGIN_LABELS[s.origin] || s.origin)}</b>
            ${lang}
            <span class="cp-src-q">${escapeHtml(String(s.quality || 'Auto'))}${escapeHtml(provider)}</span>
            ${fluxBadge}
          </span>
          ${ms}
        </button>`;
    }).join('');
  }

  /* ───────────── PRÉFS ───────────── */

  applyPrefsToUi() {
    const v = this.video;
    v.volume = this.prefs.volume ?? 1;
    v.style.filter = `brightness(${this.prefs.bright}) contrast(${this.prefs.contrast}) saturate(${this.prefs.sat})`;
    if (this.menuSet) {
      const sp = this.menuSet.querySelector('#cp-fx-speed');
      if (sp) sp.value = String(this.prefs.speed || 1);
    }
    v.playbackRate = this.prefs.speed || 1;
  }

  _savePref(partial) {
    Object.assign(this.prefs, partial);
    // Synchronise aussi la référence partagée (prefs dans video.js) pour que
    // le prochain serveur chargé dans la même session hérite des nouvelles préfs.
    if (this.ctx.prefs && typeof this.ctx.prefs === 'object') {
      Object.assign(this.ctx.prefs, partial);
    }
    savePrefs(this.sb, this.session, partial);
  }

  /* ───────────── AUDIO ───────────── */

  setupAudio() {
    try {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.audioCtx.createMediaElementSource(this.video);
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = this.prefs.gain || 1;
      src.connect(this.gainNode).connect(this.audioCtx.destination);
    } catch(e) { /* audio context not supported */ }
  }

  /* ───────────── CHARGEMENT ───────────── */

  loadSrc(src, keepTime = false) {
    if (!src) return;
    const t = keepTime ? this.video.currentTime : 0;
    const wasPlaying = !this.video.paused;
    this.cp.classList.add('loading');
    const useHls = src.isHls || (typeof src.url === 'string' && src.url.includes('.m3u8'));

    if (useHls && window.Hls && window.Hls.isSupported()) {
      if (this._hls) { try { this._hls.destroy(); } catch{} this._hls = null; }
      this._hls = new window.Hls();
      this._hls.loadSource(src.url);
      this._hls.attachMedia(this.video);
      this._hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        this._maybeResumeOrSeek(t);
        this.cp.classList.remove('loading');
        if (wasPlaying) this.video.play().catch(() => {});
      });
      this._hls.on(window.Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.warn('HLS fatal error');
        }
      });
    } else {
      this.video.src = src.url;
      const onMeta = () => {
        this._maybeResumeOrSeek(t);
        this.cp.classList.remove('loading');
        if (wasPlaying) this.video.play().catch(()=>{});
        this.video.removeEventListener('loadedmetadata', onMeta);
      };
      this.video.addEventListener('loadedmetadata', onMeta);
    }

    // Sous-titres inclus dans le flux ("Flux")
    if (src.caption) {
      setTimeout(() => {
        if (!this.cp) return;
        this.populateSubsLangs([{
          language: 'fr',
          language_name: 'Français',
          url: src.caption,
          source: 'flux',
        }]);
      }, 400);
    }
  }

  _maybeResumeOrSeek(t) {
    if (!this._didResume && this.resume && this.resume.position && this.resume.duration) {
      const ratio = this.resume.position / this.resume.duration;
      if (ratio > 0.02 && ratio < 0.95) {
        this.video.currentTime = this.resume.position;
        this._didResume = true;
        return;
      }
      this._didResume = true;
    }
    this.video.currentTime = t;
  }

  /**
   * Rechargement complet (changement d'épisode, etc.). Conserve le player en
   * vie pour ne pas perdre les paramètres ; juste un nouveau ctx + sources.
   */
  setSources(sources, ctx = {}) {
    this.ctx = { ...this.ctx, ...ctx };
    this.resume = ctx.resume ?? this.resume;
    this._didResume = false;
    this.sources = (sources || []).map((s, i) => ({
      url:      s.url,
      isHls:    s.isHls ?? (s.format === 'hls' || (typeof s.url === 'string' && s.url.includes('.m3u8'))),
      format:   s.format || (s.isHls ? 'hls' : 'mp4'),
      quality:  s.quality || 'Auto',
      origin:   s.origin   || 'user',
      language: s.language || null,
      label:    s.label    || null,
      ms:       s.ms       ?? null,
      caption:  s.caption  || null,
      _idx:     i,
    }));
    this.currentIdx = this._pickInitial();
    this._refreshSourcesMenu();
    this.qualityBtn.textContent = this._currentLabel(this.sources[this.currentIdx]);
    this.loadSrc(this.sources[this.currentIdx], false);
  }

  _refreshSourcesMenu() {
    const list = this.menuQ.querySelector('.cp-src-list');
    if (list) list.innerHTML = this._renderSourcesList();
    const h = this.menuQ.querySelector('h4');
    if (h) h.textContent = `Sources disponibles (${this.sources.length})`;
  }

  /* ───────────── ÉVÉNEMENTS VIDÉO ───────────── */

  attachVideoEvents() {
    const v = this.video;
    v.addEventListener('play',  () => { this.cp.classList.add('playing'); this.scheduleHide(); });
    v.addEventListener('pause', () => {
      this.cp.classList.remove('playing'); this.showControls();
      this._flushProgressNow();
    });
    v.addEventListener('ended', () => {
      this.cp.classList.remove('playing'); this.showControls();
      this._flushProgressNow();
    });
    v.addEventListener('waiting', () => this.cp.classList.add('loading'));
    v.addEventListener('canplay',  () => this.cp.classList.remove('loading'));
    v.addEventListener('timeupdate', () => {
      if (!v.duration) return;
      const p = (v.currentTime / v.duration) * 100;
      this.seek.value = p;
      this.seek.style.setProperty('--p', p + '%');
      this.timeCur.textContent = fmtTime(v.currentTime);
      this.renderActiveCue();
      this._maybeSaveProgress();
    });
    v.addEventListener('loadedmetadata', () => {
      this.timeTot.textContent = fmtTime(v.duration);
    });
    v.addEventListener('volumechange', () => {
      this.vol.value = v.muted ? 0 : v.volume;
      this.btnMute.innerHTML = v.muted || v.volume === 0
        ? `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><line x1="17" y1="9" x2="23" y2="15" stroke="currentColor" stroke-width="2"/><line x1="23" y1="9" x2="17" y2="15" stroke="currentColor" stroke-width="2"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 12c0-1.77-1-3.29-2.5-4.03v8.06c1.5-.75 2.5-2.26 2.5-4.03z"/></svg>`;
      if (!v.muted) this._savePref({ volume: v.volume });
    });
  }

  _maybeSaveProgress() {
    const v = this.video;
    if (!v.duration || !this.ctx.tmdbId) return;
    const now = Date.now();
    if (now - this._lastProgressSave < 1000) return;
    this._lastProgressSave = now;
    saveProgress(this.sb, this.session, {
      tmdbId:    this.ctx.tmdbId,
      mediaType: this.ctx.type || 'movie',
      season:    this.ctx.season,
      episode:   this.ctx.episode,
      position:  v.currentTime,
      duration:  v.duration,
    });
    if (this.ctx.onProgress) {
      try {
        this.ctx.onProgress({
          position: v.currentTime,
          duration: v.duration,
          watched: v.currentTime / v.duration >= 0.95,
        });
      } catch{}
    }
  }

  async _flushProgressNow() {
    const v = this.video;
    if (!v || !v.duration || !this.ctx.tmdbId) return;
    await flushProgress(this.sb, this.session, {
      tmdbId:    this.ctx.tmdbId,
      mediaType: this.ctx.type || 'movie',
      season:    this.ctx.season,
      episode:   this.ctx.episode,
      position:  v.currentTime,
      duration:  v.duration,
    });
  }

  attachLifecycle() {
    this._unloadHandler = () => { this._flushProgressNow(); };
    window.addEventListener('beforeunload', this._unloadHandler);
    window.addEventListener('pagehide', this._unloadHandler);
  }

  /* ───────────── ÉVÉNEMENTS UI ───────────── */

  attachUiEvents() {
    const v = this.video;

    this.bigPlay.addEventListener('click', () => { v.play(); });
    this.btnPlay.addEventListener('click', () => { if (v.paused) v.play(); else v.pause(); });
    this.seek.addEventListener('input', () => { v.currentTime = (this.seek.value / 100) * v.duration; });

    this.vol.addEventListener('input', () => { v.volume = parseFloat(this.vol.value); v.muted = false; });
    this.btnMute.addEventListener('click', () => { v.muted = !v.muted; });

    this.wrap.querySelector('.cp-prev').addEventListener('click', () => { v.currentTime = Math.max(0, v.currentTime - 10); });
    this.wrap.querySelector('.cp-fwd').addEventListener('click',  () => { v.currentTime = Math.min((v.duration||0), v.currentTime + 10); });

    this.wrap.querySelector('.cp-stretch').addEventListener('click', () => {
      const enabled = this.cp.classList.toggle('fit-cover');
      this._savePref({ fitCover: enabled });
    });

    // Menu sources (ex-qualité)
    this.qualityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.menuQ.hidden = !this.menuQ.hidden;
      this.menuS.hidden = true;
      this.menuSet.hidden = true;
    });
    this.menuQ.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-idx]');
      if (!btn) return;
      const idx = +btn.dataset.idx;
      if (idx === this.currentIdx) { this.menuQ.hidden = true; return; }
      this.currentIdx = idx;
      const src = this.sources[idx];
      this.qualityBtn.textContent = this._currentLabel(src);
      this._refreshSourcesMenu();
      this.menuQ.hidden = true;
      // Sauvegarde la préférence pour la prochaine fois
      this._savePref({ preferredOrigin: src.origin || null, preferredLang: src.language || null });
      // Flush progress avant de switcher (pour ne pas perdre la position)
      this._flushProgressNow().then(() => {
        this.loadSrc(src, true);
      });
      if (this.ctx.onSwitchSource) { try { this.ctx.onSwitchSource(idx, src); } catch{} }
    });

    this.wrap.querySelector('.cp-subs').addEventListener('click', (e) => {
      e.stopPropagation();
      this.menuS.hidden = !this.menuS.hidden;
      this.menuQ.hidden = true;
      this.menuSet.hidden = true;
    });
    this.bindSubsMenu();

    this.wrap.querySelector('.cp-settings').addEventListener('click', (e) => {
      e.stopPropagation();
      this.menuSet.hidden = !this.menuSet.hidden;
      this.menuQ.hidden = true;
      this.menuS.hidden = true;
    });
    this.bindSettingsMenu();

    this.cp.addEventListener('click', (e) => {
      if (e.target.closest('.cp-controls') || e.target.closest('.cp-menu') || e.target.closest('.cp-bigplay')) return;
      if (v.paused) v.play(); else v.pause();
      this.showControls();
    });
    this.cp.addEventListener('click', (e) => {
      if (!e.target.closest('.cp-menu') && !e.target.closest('.cp-btn')) {
        this.menuQ.hidden = true; this.menuS.hidden = true; this.menuSet.hidden = true;
      }
    });

    this.wrap.querySelector('.cp-fs').addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement) {
        this.cp.classList.add('fullscreen-active');
        this.cp.querySelectorAll('.cp-extra').forEach(el => el.style.display = '');
      } else {
        this.cp.classList.remove('fullscreen-active');
        this.cp.querySelectorAll('.cp-extra').forEach(el => el.style.display = 'none');
      }
    });
    this.cp.querySelectorAll('.cp-extra').forEach(el => el.style.display = 'none');

    this.cp.addEventListener('mousemove',  () => this.showControls());
    this.cp.addEventListener('touchstart', () => this.showControls());

    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  bindSubsMenu() {
    const fileInp = this.menuS.querySelector('#cp-subs-file');
    fileInp.addEventListener('change', async () => {
      const f = fileInp.files[0];
      if (!f) return;
      const text = await f.text();
      this.loadSubtitleText(text, f.name.toLowerCase().endsWith('.srt'));
    });
    this.menuS.querySelector('#cp-subs-url-load').onclick = async () => {
      const u = this.menuS.querySelector('#cp-subs-url').value.trim();
      if (!u) return;
      try {
        const r = await fetch(u);
        const text = await r.text();
        this.loadSubtitleText(text, u.toLowerCase().endsWith('.srt'));
      } catch(e) { alert('Échec du chargement (CORS ?)'); }
    };
    this.menuS.querySelector('[data-action="subs-off"]').onclick = () => {
      this.subtitleCues = [];
      this.subsRender.style.display = 'none';
      this.menuS.querySelectorAll('[data-lang]').forEach(b => b.classList.remove('active'));
      this.menuS.querySelector('[data-action="subs-off"]').classList.add('active');
    };

    const sz   = this.menuS.querySelector('#cp-st-size');
    const col  = this.menuS.querySelector('#cp-st-color');
    const bg   = this.menuS.querySelector('#cp-st-bg');
    const bot  = this.menuS.querySelector('#cp-st-bottom');
    const apply = () => {
      this.subtitleStyle.size = +sz.value;
      this.subtitleStyle.color = col.value;
      this.subtitleStyle.bgEnabled = bg.checked;
      this.subtitleStyle.bottom = +bot.value;
      this.applySubtitleStyle();
      this._savePref({
        subSize:   this.subtitleStyle.size,
        subColor:  this.subtitleStyle.color,
        subBg:     this.subtitleStyle.bgEnabled,
        subBottom: this.subtitleStyle.bottom,
      });
    };
    [sz, col, bg, bot].forEach(el => el.addEventListener('input', apply));
  }

  /**
   * @param subtitles [{ language, language_name, url, source? }]
   *   source = 'op'   → badge "OP"   (OpenSubtitles)
   *   source = 'flux' → badge "Flux" (inclus dans le stream)
   *   sinon → pas de badge
   *
   * Supprime les vérifications HEAD (bloquées par CORS) et affiche directement
   * toutes les langues disponibles. Auto-charge la langue de `defaultSubLang`.
   */
  populateSubsLangs(subtitles) {
    const container = this.menuS.querySelector('.cp-subs-langs');
    if (!container || !subtitles?.length) return;

    // Déduplique par langue (garde le premier de chaque langue reçue)
    const seen = new Set();
    const unique = subtitles.filter(s => {
      const lang = (s.language || '').toLowerCase();
      if (seen.has(lang)) return false;
      seen.add(lang);
      return true;
    });

    container.innerHTML = '<hr><h4>Langues disponibles</h4>';
    const buttons = [];

    unique.forEach(sub => {
      const btn = document.createElement('button');
      btn.className = 'cp-menu-item';
      btn.dataset.lang = sub.language;
      const badge = sub.source === 'op'
        ? `<span class="cp-src-badge cp-src-badge-op" title="OpenSubtitles">OP</span>`
        : sub.source === 'flux'
          ? `<span class="cp-src-badge cp-src-badge-flux" title="Inclus dans le flux">Flux</span>`
          : '';
      btn.innerHTML = `${escapeHtml(sub.language_name || sub.language)} ${badge}`;
      btn.onclick = async () => {
        try {
          const r = await fetch(sub.url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const text = await r.text();
          this.loadSubtitleText(text, /\.srt(\?|$)/i.test(sub.url));
          this.menuS.querySelectorAll('[data-lang]').forEach(b => b.classList.remove('active'));
          this.menuS.querySelector('[data-action="subs-off"]').classList.remove('active');
          btn.classList.add('active');
        } catch(e) { alert('Erreur chargement sous-titre : ' + e.message); }
      };
      container.appendChild(btn);
      buttons.push({ sub, btn });
    });

    // Auto-charge la langue préférée définie dans les préférences
    const pref = (this.prefs.defaultSubLang || '').toLowerCase();
    if (pref && pref !== 'off' && pref !== 'none') {
      const match = buttons.find(({ sub }) =>
        (sub.language || '').toLowerCase().startsWith(pref) ||
        (sub.language_name || '').toLowerCase().startsWith(pref)
      );
      if (match) {
        // Petit délai pour laisser le temps au player d'être prêt
        setTimeout(() => match.btn.click(), 700);
      }
    }
  }

  bindSettingsMenu() {
    const v = this.video;
    const br = this.menuSet.querySelector('#cp-fx-bright');
    const co = this.menuSet.querySelector('#cp-fx-contrast');
    const sa = this.menuSet.querySelector('#cp-fx-sat');
    const ga = this.menuSet.querySelector('#cp-fx-gain');
    const sp = this.menuSet.querySelector('#cp-fx-speed');
    const apply = () => {
      v.style.filter = `brightness(${br.value}) contrast(${co.value}) saturate(${sa.value})`;
      this._savePref({
        bright:   parseFloat(br.value),
        contrast: parseFloat(co.value),
        sat:      parseFloat(sa.value),
      });
    };
    [br, co, sa].forEach(el => el.addEventListener('input', apply));
    ga.addEventListener('input', () => {
      if (this.gainNode) {
        try { this.audioCtx.resume(); } catch(e) {}
        this.gainNode.gain.value = parseFloat(ga.value);
      }
      this._savePref({ gain: parseFloat(ga.value) });
    });
    sp.addEventListener('change', () => {
      v.playbackRate = parseFloat(sp.value);
      this._savePref({ speed: parseFloat(sp.value) });
    });
    this.menuSet.querySelector('#cp-fx-reset').onclick = () => {
      br.value = DEFAULT_PREFS.bright; co.value = DEFAULT_PREFS.contrast;
      sa.value = DEFAULT_PREFS.sat;    ga.value = DEFAULT_PREFS.gain;
      sp.value = DEFAULT_PREFS.speed;
      v.style.filter = `brightness(${br.value}) contrast(${co.value}) saturate(${sa.value})`;
      if (this.gainNode) this.gainNode.gain.value = DEFAULT_PREFS.gain;
      v.playbackRate = DEFAULT_PREFS.speed;
      this._savePref({
        bright: DEFAULT_PREFS.bright, contrast: DEFAULT_PREFS.contrast,
        sat: DEFAULT_PREFS.sat, gain: DEFAULT_PREFS.gain, speed: DEFAULT_PREFS.speed,
      });
    };
  }

  loadSubtitleText(text, isSrt) {
    if (isSrt) text = srtToVtt(text);
    this.subtitleCues = parseVtt(text);
    this.subsRender.style.display = '';
    this.applySubtitleStyle();
    this.renderActiveCue();
  }

  applySubtitleStyle() {
    const s = this.subtitleStyle;
    this.subsRender.style.fontSize = s.size + 'px';
    this.subsRender.style.color = s.color;
    this.subsRender.style.bottom = s.bottom + '%';
    const span = this.subsRender.querySelector('span');
    if (span) span.style.background = s.bgEnabled ? s.bg : 'transparent';
  }

  renderActiveCue() {
    if (!this.subtitleCues.length) return;
    const t = this.video.currentTime;
    const cue = this.subtitleCues.find(c => t >= c.start && t <= c.end);
    if (cue) {
      const s = this.subtitleStyle;
      this.subsRender.innerHTML = `<span style="background:${s.bgEnabled?s.bg:'transparent'}">${escapeHtml(cue.text).replace(/\n/g, '<br>')}</span>`;
    } else {
      this.subsRender.innerHTML = '';
    }
  }

  toggleFullscreen() {
    const wrap = this.wrap;
    if (!document.fullscreenElement) {
      (wrap.requestFullscreen?.bind(wrap) || wrap.webkitRequestFullscreen?.bind(wrap))?.();
    } else {
      (document.exitFullscreen?.bind(document) || document.webkitExitFullscreen?.bind(document))?.();
    }
  }

  showControls() {
    this.cp.classList.remove('hide-controls');
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (!this.video.paused) this.scheduleHide();
  }
  scheduleHide(ms = 2800) {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (this.menuQ.hidden && this.menuS.hidden && this.menuSet.hidden && !this.video.paused) {
        this.cp.classList.add('hide-controls');
      }
    }, ms);
  }

  onKey(e) {
    const v = this.video;
    if (e.target.matches('input, select, textarea')) return;
    switch (e.key) {
      case ' ': case 'k': case 'Enter': case 'MediaPlayPause':
        e.preventDefault(); if (v.paused) v.play(); else v.pause(); break;
      case 'ArrowRight': case 'MediaFastForward':
        e.preventDefault(); v.currentTime = Math.min((v.duration||0), v.currentTime + 10); break;
      case 'ArrowLeft': case 'MediaRewind':
        e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); break;
      case 'ArrowUp':
        e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); break;
      case 'ArrowDown':
        e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); break;
      case 'm': case 'M': case 'AudioVolumeMute': v.muted = !v.muted; break;
      case 'f': case 'F': this.toggleFullscreen(); break;
      case 'Escape': case 'GoBack': case 'Back':
        if (!this.menuQ.hidden || !this.menuS.hidden || !this.menuSet.hidden) {
          this.menuQ.hidden = true; this.menuS.hidden = true; this.menuSet.hidden = true;
        } else if (document.fullscreenElement) {
          this.toggleFullscreen();
        }
        break;
    }
    this.showControls();
  }

  destroy() {
    try { this._flushProgressNow(); } catch{}
    try { window.removeEventListener('beforeunload', this._unloadHandler); } catch{}
    try { window.removeEventListener('pagehide', this._unloadHandler); } catch{}
    try { this.video.pause(); this.video.src = ''; } catch(e){}
    try { if (this._hls) { this._hls.destroy(); this._hls = null; } } catch(e){}
    try { this.audioCtx?.close(); } catch(e){}
    this.wrap.innerHTML = '';
  }
}

/* ───────────── HELPERS ───────────── */

function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}
function parseVtt(text) {
  const cues = [];
  const blocks = text.replace(/^WEBVTT[^\n]*\n+/i, '').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.trim().split('\n');
    if (!lines.length) continue;
    const tIdx = lines.findIndex(l => l.includes('-->'));
    if (tIdx < 0) continue;
    const m = lines[tIdx].match(/(\d+):(\d+):(\d+)[.,](\d+)\s*-->\s*(\d+):(\d+):(\d+)[.,](\d+)/);
    if (!m) continue;
    const start = (+m[1])*3600 + (+m[2])*60 + (+m[3]) + (+m[4])/1000;
    const end   = (+m[5])*3600 + (+m[6])*60 + (+m[7]) + (+m[8])/1000;
    const txt = lines.slice(tIdx+1).join('\n').replace(/<[^>]+>/g, '');
    cues.push({ start, end, text: txt });
  }
  return cues;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
