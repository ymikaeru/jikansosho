/* karaoke.js — leitura em voz alta com a voz do sistema (Web Speech API)
   e destaque sincronizado, no estilo do Culto Mensal do guia_johrei, mas por
   FRASE e com preenchimento caractere a caractere dentro da frase.

   Unidade = { el, segs, gap }  (segs: string | [base, leitura])
   - A frase atual recebe .cur; seus caracteres são envolvidos em <span.k>
     e recebem .done conforme a voz avança.
   - Progresso dentro da frase: eventos `boundary` (charIndex) quando a voz
     os envia; senão, estimativa por tempo, recalibrada a cada trecho com a
     duração real (caracteres/segundo).
   - Frases longas são faladas em trechos curtos (corte em 、), o que evita o
     bug do Chrome que corta falas de mais de ~15 s.
   - "Pausa" = cancel() + guardar a frase atual (pause() falha no Android).
*/
(function () {
  'use strict';

  const CHUNK_SOFT = 40;   // a partir daqui, corta no próximo 、
  const CHUNK_HARD = 80;   // corte forçado

  /* ---------- Vozes ---------- */
  function jaVoices() {
    if (!('speechSynthesis' in window)) return [];
    return speechSynthesis.getVoices().filter(v => /^ja/i.test(v.lang));
  }
  function voiceScore(v) {
    const n = v.name;
    if (/Natural|Online/i.test(n)) return 4;          // Edge: Nanami / Keita (neural)
    if (/Google/i.test(n)) return 3;
    if (/Kyoko|O-ren|Haruka|Ayumi|Sayaka|Nanami/i.test(n)) return 2;
    return 1;
  }
  function pickVoice(uri) {
    const list = jaVoices();
    if (!list.length) return null;
    const saved = uri && list.find(v => v.voiceURI === uri);
    if (saved) return saved;
    return list.slice().sort((a, b) => voiceScore(b) - voiceScore(a))[0];
  }

  /* ---------- Texto falado + mapa para os caracteres exibidos ---------- */
  // Devolve { speak, map, units } onde units[k] é o HTML do k-ésimo caractere
  // exibido (ruby inteira = 1 unidade) e map[i] = k para cada char falado.
  function prepare(segs) {
    const units = [];
    let speak = '';
    const map = [];
    const push = (txt, k) => { for (const c of txt) { speak += c; map.push(k); } };
    segs.forEach(seg => {
      if (typeof seg === 'string') {
        for (const c of seg) {
          const k = units.push(JKS.escapeHtml(c)) - 1;
          if (c === '―' || c === '—') {
            if (!speak.endsWith('、')) push('、', k);   // ―― vira uma pausa
          } else if (c === '　' || c === ' ') {
            if (!speak.endsWith('、')) push('、', k);
          } else {
            push(c, k);
          }
        }
      } else {
        const k = units.push('<ruby>' + JKS.escapeHtml(seg[0]) + '<rt>' + JKS.escapeHtml(seg[1]) + '</rt></ruby>') - 1;
        push(seg[1], k);   // a voz usa a leitura do próprio original
      }
    });
    return { speak, map, units };
  }

  function chunksOf(speak) {
    const out = [];
    let start = 0;
    for (let i = 0; i < speak.length; i++) {
      const len = i - start + 1;
      const c = speak[i];
      const soft = len >= CHUNK_SOFT && (c === '、' || c === '，' || c === '」');
      if (soft || len >= CHUNK_HARD) {
        out.push({ start, text: speak.slice(start, i + 1) });
        start = i + 1;
      }
    }
    if (start < speak.length) out.push({ start, text: speak.slice(start) });
    // trecho final minúsculo: junta ao anterior
    if (out.length > 1 && out[out.length - 1].text.length < 8) {
      const last = out.pop();
      out[out.length - 1].text += last.text;
    }
    return out.filter(c => c.text.replace(/[、。「」『』（）\s]/g, '').length > 0);
  }

  /* ---------- Speaker ---------- */
  class Speaker {
    constructor(opts) {
      this.opts = opts || {};
      this.units = [];
      this.idx = 0;
      this.playing = false;
      this.gen = 0;              // invalida callbacks de falas canceladas
      this.cps1 = 6.5;           // caracteres/segundo na velocidade 1.0 (calibrado)
      this.rate = 1;
      this.voiceURI = '';
      this.wakeLock = null;
      this._cur = null;          // { el, html, prep, kDone }
      this._raf = 0;
      this.supported = 'speechSynthesis' in window;
      if (this.supported) {
        speechSynthesis.addEventListener('voiceschanged', () => {
          if (this.opts.onVoices) this.opts.onVoices(jaVoices());
        });
      }
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.playing) this._lockScreen();
      });
    }

    static voices() { return jaVoices(); }

    load(units) {
      this.stop();
      this.units = units;
      this.idx = 0;
    }

    setRate(r) { this.rate = r; if (this.playing) this.play(this.idx); }
    setVoice(uri) { this.voiceURI = uri; if (this.playing) this.play(this.idx); }

    /* Começa (ou recomeça) na unidade i. Deve ser chamado a partir de um
       clique na 1ª vez (iOS/Chrome exigem gesto do usuário). */
    play(i) {
      if (!this.supported) { this._msg('no-support'); return; }
      const voice = pickVoice(this.voiceURI);
      if (!voice && jaVoices().length === 0 && speechSynthesis.getVoices().length > 0) {
        this._msg('no-voice');
        return;
      }
      this.gen++;
      speechSynthesis.cancel();
      if (typeof i === 'number') this.idx = Math.max(0, Math.min(i, this.units.length - 1));
      this.playing = true;
      this._lockScreen();
      this._emit('onState', true);
      this._speakUnit(this.gen);
    }

    stop() {
      this.gen++;
      if (this.supported) speechSynthesis.cancel();
      cancelAnimationFrame(this._raf);
      this._leaveUnit();
      if (this.playing) {
        this.playing = false;
        this._emit('onState', false);
      }
      this._unlockScreen();
    }

    toggle() { this.playing ? this.stop() : this.play(this.idx); }
    next() { if (this.idx < this.units.length - 1) this._jump(this.idx + 1); }
    prev() { if (this.idx > 0) this._jump(this.idx - 1); }

    _jump(i) {
      if (this.playing) this.play(i);
      else { this.idx = i; this._emit('onUnit', i); }
    }

    /* --- interno --- */
    _emit(name, ...args) { if (this.opts[name]) this.opts[name](...args); }
    _msg(code) { this._emit('onMessage', code); }

    _enterUnit(i) {
      this._leaveUnit();
      const u = this.units[i];
      const prep = prepare(u.segs);
      const html = u.el.innerHTML;
      u.el.innerHTML = prep.units.map(h => '<span class="k">' + h + '</span>').join('');
      u.el.classList.add('cur');
      this._cur = { el: u.el, html, prep, ks: u.el.querySelectorAll('.k'), kDone: -1 };
      this._emit('onUnit', i);
      return prep;
    }

    _leaveUnit() {
      const c = this._cur;
      if (!c) return;
      c.el.innerHTML = c.html;
      c.el.classList.remove('cur');
      this._cur = null;
    }

    _fill(speakPos) {
      const c = this._cur;
      if (!c) return;
      const k = c.prep.map[Math.max(0, Math.min(speakPos, c.prep.map.length - 1))];
      for (let j = c.kDone + 1; j <= k; j++) c.ks[j].classList.add('done');
      if (k > c.kDone) c.kDone = k;
    }

    _speakUnit(gen) {
      if (gen !== this.gen) return;
      if (this.idx >= this.units.length) {
        this._leaveUnit();
        this.playing = false;
        this._unlockScreen();
        this._emit('onState', false);
        this._emit('onEnd');
        return;
      }
      const prep = this._enterUnit(this.idx);
      const chunks = chunksOf(prep.speak);
      const voice = pickVoice(this.voiceURI);
      let ci = 0;

      const finishUnit = () => {
        if (gen !== this.gen) return;
        this._fill(prep.speak.length - 1);
        const gap = this.units[this.idx].gap || 0;
        this.idx++;
        setTimeout(() => this._speakUnit(gen), gap);
      };

      const speakChunk = () => {
        if (gen !== this.gen) return;
        if (ci >= chunks.length) { finishUnit(); return; }
        const ch = chunks[ci];
        const u = new SpeechSynthesisUtterance(ch.text);
        u.lang = 'ja-JP';
        if (voice) u.voice = voice;
        u.rate = this.rate;
        let t0 = 0, boundaryPos = -1, ended = false, watchdog = 0;

        const tick = () => {
          if (gen !== this.gen || ended) return;
          if (t0) {
            const est = (performance.now() - t0) / 1000 * this.cps1 * this.rate;
            const fromTime = ch.start + Math.min(Math.floor(est), ch.text.length - 1);
            // com boundary, nunca ultrapassa a palavra atual; sem, usa o tempo
            this._fill(boundaryPos >= 0 ? Math.min(Math.max(boundaryPos, fromTime), this._boundaryEnd) : fromTime);
          }
          this._raf = requestAnimationFrame(tick);
        };

        const done = () => {
          if (ended) return;
          ended = true;
          clearTimeout(watchdog);
          cancelAnimationFrame(this._raf);
          if (gen !== this.gen) return;
          if (t0) {
            const secs = (performance.now() - t0) / 1000;
            if (secs > 0.6 && boundaryPos < 0) {
              const measured = ch.text.length / secs / this.rate;
              if (measured > 2 && measured < 20) this.cps1 = this.cps1 * 0.6 + measured * 0.4;
            }
          }
          ci++;
          speakChunk();
        };

        u.onstart = () => {
          if (gen !== this.gen) return;
          t0 = performance.now();
          // trava de segurança: se a voz "engolir" o fim (sem onend), segue em frente
          const expected = ch.text.length / (this.cps1 * this.rate) * 1000;
          watchdog = setTimeout(done, expected * 3 + 4000);
        };
        u.onboundary = (e) => {
          if (gen !== this.gen || typeof e.charIndex !== 'number') return;
          if (e.name && e.name !== 'word') return;
          boundaryPos = ch.start + e.charIndex;
          const len = e.charLength || 1;
          this._boundaryEnd = ch.start + Math.min(e.charIndex + len, ch.text.length) - 1;
        };
        u.onend = done;
        u.onerror = (e) => {
          if (e.error === 'interrupted' || e.error === 'canceled') return;
          if (e.error === 'not-allowed') { this.stop(); this._msg('not-allowed'); return; }
          done();
        };
        this._utter = u;                 // evita GC no Chrome (onend sumindo)
        this._boundaryEnd = ch.start + ch.text.length - 1;
        speechSynthesis.speak(u);
        this._raf = requestAnimationFrame(tick);
      };

      speakChunk();
    }

    async _lockScreen() {
      try {
        if ('wakeLock' in navigator && !this.wakeLock) {
          this.wakeLock = await navigator.wakeLock.request('screen');
          this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
        }
      } catch (e) { /* sem permissão: ignora */ }
    }
    _unlockScreen() {
      if (this.wakeLock) { try { this.wakeLock.release(); } catch (e) {} this.wakeLock = null; }
    }
  }

  /* ---------- AudioPlayer: MP3 narrado + tempos do alinhamento ----------
     Mesma interface do Speaker (load/play/stop/toggle/next/prev/setRate e os
     callbacks onUnit/onState/onEnd/onMessage). Os tempos vêm de
     data/volNN_audio.js (scripts/audio_pipeline.py): por unidade,
     [início, [[k, tempo], ...]] — k = índice do caractere exibido, o mesmo
     de prepare(). Toca em segundo plano e com a tela apagada. */
  class AudioPlayer {
    constructor(opts) {
      this.opts = opts || {};
      this.units = [];
      this.times = [];
      this.idx = 0;
      this.playing = false;
      this.rate = 1;
      this.supported = true;
      this._cur = null;
      this._curIdx = -1;
      this._raf = 0;
      this._src = '';
      const a = this.audio = new Audio();
      a.preload = 'metadata';
      a.addEventListener('play', () => { this.playing = true; this._emit('onState', true); this._loop(); });
      a.addEventListener('pause', () => {
        cancelAnimationFrame(this._raf);
        if (this.playing) { this.playing = false; this._emit('onState', false); }
      });
      a.addEventListener('ended', () => {
        cancelAnimationFrame(this._raf);
        this._leaveUnit();
        this.playing = false;
        this._emit('onState', false);
        this._emit('onEnd');
      });
      a.addEventListener('error', () => {
        if (!a.getAttribute('src')) return;
        this.playing = false;
        this._emit('onState', false);
        this._emit('onMessage', 'audio-error');
      });
      this._mediaSession();
    }

    load(units, chapterAudio, title) {
      this.stop();
      this._leaveUnit();
      this.units = units;
      this.times = chapterAudio.u;
      this.idx = 0;
      this._curIdx = -1;
      if (this._src !== chapterAudio.src) {
        this._src = chapterAudio.src;
        this.audio.src = chapterAudio.src;
      }
      this.audio.playbackRate = this.rate;
      if ('mediaSession' in navigator && window.MediaMetadata) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: title || '', artist: '岡田自観（明主様）', album: '光への道' });
      }
    }

    play(i) {
      if (typeof i === 'number') this.idx = Math.max(0, Math.min(i, this.units.length - 1));
      const t = this.times[this.idx] ? this.times[this.idx][0] : 0;
      const a = this.audio;
      a.playbackRate = this.rate;
      const go = () => {
        this._leaveUnit();               // recomeça o preenchimento da frase
        try { a.currentTime = Math.max(0, t - 0.05); } catch (e) {}
        const p = a.play();
        if (p && p.catch) p.catch(() => this._emit('onMessage', 'not-allowed'));
      };
      if (a.readyState >= 1) go();
      else { a.addEventListener('loadedmetadata', go, { once: true }); try { a.load(); } catch (e) {} }
    }

    stop() {
      if (!this.audio.paused) this.audio.pause();
      cancelAnimationFrame(this._raf);
    }
    toggle() { this.playing ? this.stop() : this.play(this.idx); }
    next() { if (this.idx < this.units.length - 1) this._jump(this.idx + 1); }
    prev() {
      // como num player de música: no meio da frase, volta ao começo dela
      const t = this.audio.currentTime;
      const start = this.times[this.idx] ? this.times[this.idx][0] : 0;
      this._jump(this.playing && t - start > 1.5 ? this.idx : Math.max(0, this.idx - 1));
    }
    setRate(r) { this.rate = r; this.audio.playbackRate = r; }
    setVoice() {}

    _jump(i) {
      if (this.playing) this.play(i);
      else { this.idx = i; this._emit('onUnit', i); }
    }
    _emit(name, ...args) { if (this.opts[name]) this.opts[name](...args); }

    _unitAt(t) {
      let lo = 0, hi = this.times.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.times[mid][0] <= t + 0.02) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    }

    _loop() {
      cancelAnimationFrame(this._raf);
      const tick = () => {
        if (!this.playing) return;
        this._sync(this.audio.currentTime);
        this._raf = requestAnimationFrame(tick);
      };
      tick();
    }

    _sync(t) {
      const i = this._unitAt(t);
      if (i !== this._curIdx) {
        this._enterUnit(i);
        this.idx = i;
        this._emit('onUnit', i);
      }
      const marks = this.times[i][1];
      const c = this._cur;
      if (!c || !marks.length) return;
      // palavra atual inteira: até o caractere anterior à próxima marca
      let j = -1;
      for (let m = 0; m < marks.length && marks[m][1] <= t + 0.02; m++) j = m;
      if (j < 0) return;
      const k = j + 1 < marks.length ? marks[j + 1][0] - 1 : c.ks.length - 1;
      for (let x = c.kDone + 1; x <= k && x < c.ks.length; x++) c.ks[x].classList.add('done');
      if (k > c.kDone) c.kDone = k;
    }

    _enterUnit(i) {
      this._leaveUnit();
      const u = this.units[i];
      if (!u) return;
      const html = u.el.innerHTML;
      u.el.innerHTML = prepare(u.segs).units.map(h => '<span class="k">' + h + '</span>').join('');
      u.el.classList.add('cur');
      this._cur = { el: u.el, html, ks: u.el.querySelectorAll('.k'), kDone: -1 };
      this._curIdx = i;
    }
    _leaveUnit() {
      const c = this._cur;
      if (!c) return;
      c.el.innerHTML = c.html;
      c.el.classList.remove('cur');
      this._cur = null;
      this._curIdx = -1;
    }

    _mediaSession() {
      if (!('mediaSession' in navigator)) return;
      const ms = navigator.mediaSession;
      const set = (a, f) => { try { ms.setActionHandler(a, f); } catch (e) {} };
      set('play', () => this.play(this.idx));
      set('pause', () => this.stop());
      set('previoustrack', () => this.prev());
      set('nexttrack', () => this.next());
      set('seekbackward', () => { this.audio.currentTime = Math.max(0, this.audio.currentTime - 10); });
      set('seekforward', () => { this.audio.currentTime = this.audio.currentTime + 10; });
    }
  }

  window.JKSpeaker = Speaker;
  window.JKAudioPlayer = AudioPlayer;
  window.JKSpeaker.prepare = prepare;   // para depuração
})();
