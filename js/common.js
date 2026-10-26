/* common.js — configurações de leitura, progresso e utilidades de texto.
   Carregado no <head> (antes do body) para aplicar tema/tamanho sem "piscar". */
(function () {
  'use strict';

  const SETTINGS_KEY = 'jks.settings';
  const SIZES = [16, 19, 22, 26, 30];            // 小・中・大・特大・最大
  const SIZE_LABELS = ['小', '中', '大', '特大', '最大'];
  const RATES = [0.75, 0.9, 1.0, 1.2];
  const RATE_LABELS = ['ゆっくり', '少しゆっくり', 'ふつう', 'はやめ'];

  const DEFAULTS = {
    size: 1,            // índice em SIZES
    font: 'gothic',     // gothic | mincho
    theme: 'light',     // light | cream | dark | contrast
    ruby: true,
    vertical: false,
    spacing: 'wide',    // normal | wide
    rate: 1,            // índice em RATES
    engine: 'audio',    // audio (朗読 MP3) | tts (voz do sistema)
    voice: '',          // voiceURI
    autoNext: true,
  };

  function safeGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* modo privado */ }
  }

  let settings = Object.assign({}, DEFAULTS, safeGet(SETTINGS_KEY) || {});

  function applySettings() {
    const root = document.documentElement;
    root.style.setProperty('--fs', SIZES[settings.size] + 'px');
    root.dataset.theme = settings.theme;
    root.dataset.font = settings.font;
    root.dataset.spacing = settings.spacing;
    root.classList.toggle('no-ruby', !settings.ruby);
    root.classList.toggle('vertical', !!settings.vertical);
  }

  function setSetting(key, val) {
    settings[key] = val;
    safeSet(SETTINGS_KEY, settings);
    applySettings();
    document.dispatchEvent(new CustomEvent('jks:settings', { detail: { key, val } }));
  }

  /* --- Progresso por volume: { last: {ch, s}, read: [n...] } (capítulos 1-based) --- */
  function progressKey(vol) { return 'jks.progress.v' + vol; }
  function getProgress(vol) {
    const p = safeGet(progressKey(vol)) || {};
    return { last: p.last || null, read: Array.isArray(p.read) ? p.read : [] };
  }
  function saveLast(vol, ch, s) {
    const p = getProgress(vol);
    p.last = { ch, s: s || 0, t: Date.now() };
    safeSet(progressKey(vol), p);
  }
  function markRead(vol, ch) {
    const p = getProgress(vol);
    if (!p.read.includes(ch)) p.read.push(ch);
    safeSet(progressKey(vol), p);
  }

  /* --- Texto --- */
  // Segmento: string ou [base, leitura]
  function segText(seg) { return typeof seg === 'string' ? seg : seg[0]; }
  function sentenceText(sent) { return sent.map(segText).join(''); }
  function chapterChars(ch) {
    let n = ch.title.length;
    ch.blocks.forEach(b => b.s.forEach(s => { n += sentenceText(s).length; }));
    return n;
  }
  // Leitura silenciosa ~400 字/分; voz do sistema ~330 字/分 na velocidade 1.0
  function readMinutes(chars) { return Math.max(1, Math.round(chars / 400)); }
  function listenMinutes(chars, rate) { return Math.max(1, Math.round(chars / (330 * (rate || 1)))); }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 1 -> 一, 21 -> 二十一 (números de capítulo em kanji)
  function kanjiNum(n) {
    const d = '〇一二三四五六七八九';
    if (n < 10) return d[n];
    const t = Math.floor(n / 10), o = n % 10;
    return (t > 1 ? d[t] : '') + '十' + (o ? d[o] : '');
  }

  /* --- Volumes (data/library.js) --- */
  function library() { return window.JIKAN_LIBRARY || []; }
  // ?vol=N validado contra a estante; sem parâmetro, o primeiro volume
  function currentVol() {
    let n = NaN;
    try { n = parseInt(new URLSearchParams(location.search).get('vol'), 10); } catch (e) {}
    const lib = library();
    const hit = lib.find(v => v.vol === n);
    return hit ? hit.vol : (lib[0] ? lib[0].vol : 9);
  }
  function volMeta(vol) { return library().find(v => v.vol === vol) || null; }
  // Injeta, durante o parse, os <script> de dados do volume (texto e áudio),
  // para que os scripts da página rodem já com window.JIKAN_VOLUMES pronto.
  function writeVolumeData(withAudio) {
    const vol = currentVol();
    const meta = volMeta(vol);
    const nn = String(vol).padStart(2, '0');
    document.write('<script src="data/vol' + nn + '.js"><\/script>');
    if (withAudio && meta && meta.audio) document.write('<script src="data/vol' + nn + '_audio.js"><\/script>');
  }

  applySettings();

  window.JKS = {
    library, currentVol, volMeta, writeVolumeData,
    SIZES, SIZE_LABELS, RATES, RATE_LABELS,
    get settings() { return settings; },
    setSetting, applySettings,
    getProgress, saveLast, markRead,
    segText, sentenceText, chapterChars, readMinutes, listenMinutes,
    escapeHtml, kanjiNum,
  };
})();
