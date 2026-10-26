/* reader.js — leitor de um capítulo por tela, com karaokê (js/karaoke.js).
   URL: read.html?ch=N[&s=K][&listen=1]   (N 1-based; K = índice da unidade)
   A troca de capítulo é feita na própria página (pushState) para que a
   leitura em voz alta possa seguir para o próximo capítulo sem novo gesto. */
(function () {
  'use strict';

  const VOL = 9;
  const book = window.JIKAN_VOLUMES && window.JIKAN_VOLUMES[VOL];
  const $ = (id) => document.getElementById(id);
  const reader = $('reader');
  if (!book) { reader.textContent = 'データを読み込めませんでした。'; return; }

  const total = book.chapters.length;
  let chNo = 1;                 // capítulo atual (1-based)
  let units = [];
  let follow = true;
  let openedAt = 0;
  let programmaticScroll = 0;

  const MSG = {
    'no-support': 'このブラウザは読み上げに対応していません。Chrome・Edge・Safari の新しい版でお試しください。',
    'no-voice': 'この端末に日本語の読み上げ音声が見つかりません。端末の設定で日本語の音声を追加してください。',
    'not-allowed': '読み上げが始まりませんでした。もう一度「聞く」を押してください。',
    'audio-error': '朗読の音声を読み込めませんでした。端末の音声で読み上げます。',
  };

  // Dois motores com a mesma interface:朗読 (MP3 + tempos alinhados) e a voz
  // do sistema. `speaker` aponta para o motor em uso no capítulo atual.
  const AUDIO = window.JIKAN_AUDIO && window.JIKAN_AUDIO[VOL];
  let audioFailed = false;
  const hasAudio = (n) => !!(AUDIO && AUDIO.chapters[n]) && !audioFailed;
  const useAudio = (n) => JKS.settings.engine !== 'tts' && hasAudio(n);

  const engineOpts = {
    onUnit: (i) => {
      JKS.saveLast(VOL, chNo, i);
      if (follow && speaker.playing) scrollToUnit(i);
    },
    onState: (playing) => {
      $('btnPlay').classList.toggle('is-playing', playing);
      $('playLabel').textContent = playing ? '止める' : '聞く';
      $('btnPlay').classList.remove('pulse');
      if (playing) { follow = true; $('btnFollow').hidden = true; setMsg(''); }
      else $('btnFollow').hidden = true;
    },
    onEnd: () => {
      JKS.markRead(VOL, chNo);
      if (JKS.settings.autoNext && chNo < total) {
        setMsg('次の話へ進みます…');
        setTimeout(() => {
          openChapter(chNo + 1, 0, true);
          speaker.play(0);
        }, 1200);
      } else {
        const end = reader.querySelector('.ch-end');
        if (end) end.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    },
    onMessage: (code) => {
      setMsg(MSG[code] || '');
      if (code === 'audio-error') {
        // sem o MP3 (offline, arquivo ausente): continua com a voz do sistema
        audioFailed = true;
        const i = speaker.idx;
        openChapter(chNo, i, false);
        speaker.play(i);
      }
    },
    onVoices: fillVoices,
  };
  const tts = new JKSpeaker(engineOpts);
  const narr = AUDIO ? new JKAudioPlayer(engineOpts) : null;
  let speaker = tts;
  [tts, narr].forEach(e => { if (e) e.rate = JKS.RATES[JKS.settings.rate]; });
  tts.voiceURI = JKS.settings.voice;

  function setMsg(t) { $('playerMsg').textContent = t; }

  /* ---------- Render ---------- */
  function segsHtml(segs) {
    return segs.map(s => typeof s === 'string'
      ? JKS.escapeHtml(s)
      : '<ruby>' + JKS.escapeHtml(s[0]) + '<rt>' + JKS.escapeHtml(s[1]) + '</rt></ruby>').join('');
  }

  function chapterMeta(n) {
    const ch = book.chapters[n - 1];
    const chars = JKS.chapterChars(ch);
    const rate = JKS.RATES[JKS.settings.rate];
    return {
      ch, chars,
      read: JKS.readMinutes(chars),
      listen: useAudio(n)
        ? Math.max(1, Math.round(AUDIO.chapters[n].dur / rate / 60))
        : JKS.listenMinutes(chars, rate),
    };
  }

  function openChapter(n, unitIdx, push) {
    tts.stop();
    if (narr) narr.stop();
    chNo = Math.max(1, Math.min(total, n));
    speaker = useAudio(chNo) ? narr : tts;
    const { ch, read, listen } = chapterMeta(chNo);
    const parts = [];
    const segsList = [];          // paralelo a data-u
    const gaps = [];
    const sent = (segs, gap) => {
      const u = segsList.push(segs) - 1;
      gaps.push(gap);
      return '<span class="s" data-u="' + u + '">' + segsHtml(segs) + '</span>';
    };

    parts.push('<header class="ch-head"><p class="ch-kicker">第' + JKS.kanjiNum(chNo) + '話 ／ 全' + JKS.kanjiNum(total) +
      '話　・　読む 約' + read + '分　・　聞く 約' + listen + '分</p>' +
      '<h1 class="ch-title">' + sent([ch.title], 700) + '</h1></header>');

    ch.blocks.forEach(b => {
      const last = b.s.length - 1;
      if (b.t === 'waka') {
        parts.push('<div class="waka">' + b.s.map((s, j) => sent(s, j === last ? 700 : 450)).join('') + '</div>');
      } else {
        const cls = b.t === 'note' ? 'note' : (b.i ? 'indent' : '');
        parts.push('<p' + (cls ? ' class="' + cls + '"' : '') + '>' +
          b.s.map((s, j) => sent(s, j === last ? 350 : 0)).join('') + '</p>');
      }
    });

    parts.push(endCardHtml());
    reader.innerHTML = parts.join('');

    units = Array.from(reader.querySelectorAll('.s')).map((el, i) => ({ el, segs: segsList[i], gap: gaps[i] }));
    if (speaker === narr) narr.load(units, AUDIO.chapters[chNo], ch.title);
    else tts.load(units);
    speaker.idx =Math.max(0, Math.min(unitIdx || 0, units.length - 1));

    $('where').textContent = '第' + chNo + '話 ／ 全' + total + '話';
    document.title = ch.title + '｜' + book.title + '｜自観叢書';
    const url = 'read.html?ch=' + chNo;
    try { history[push ? 'pushState' : 'replaceState']({ ch: chNo }, '', url); } catch (e) {}

    JKS.saveLast(VOL, chNo, speaker.idx);
    openedAt = Date.now();
    observeEnd();
    renderToc();

    if (speaker.idx > 0) scrollToUnit(speaker.idx, true);
    else resetScroll();
  }

  function endCardHtml() {
    if (chNo < total) {
      const nx = chapterMeta(chNo + 1);
      return '<section class="ch-end">' +
        '<p class="done-msg">第' + JKS.kanjiNum(chNo) + '話、おつかれさまでした。</p>' +
        '<p class="sub">全' + total + '話のうち ' + chNo + '話目まで来ました。</p>' +
        '<button class="btn btn-primary" type="button" data-go="' + (chNo + 1) + '">次の話へ進む' +
        '<span class="next-ttl">「' + JKS.escapeHtml(nx.ch.title) + '」 約' + nx.read + '分</span></button>' +
        '<a class="btn" href="index.html">今日はここまで</a>' +
        '</section>';
    }
    return '<section class="ch-end">' +
      '<p class="done-msg">『' + JKS.escapeHtml(book.title) + '』を読み終えました。</p>' +
      '<p class="sub">最後まで、おつかれさまでした。</p>' +
      '<a class="btn btn-primary" href="index.html">トップへもどる</a>' +
      '<div class="colophon"><h3>奥付</h3>' + book.colophon.map(JKS.escapeHtml).join('<br>') + '</div>' +
      '</section>';
  }

  /* ---------- Rolagem / acompanhar ---------- */
  function resetScroll() {
    programmaticScroll = Date.now();
    window.scrollTo(0, 0);
    reader.scrollLeft = 0;
  }

  function scrollToUnit(i, instant) {
    const u = units[i];
    if (!u) return;
    programmaticScroll = Date.now();
    u.el.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'center', inline: 'center' });
  }

  // Gesto do usuário durante a leitura solta o "acompanhar" (como no Culto Mensal)
  function userScrolled() {
    if (!speaker.playing || !follow) return;
    follow = false;
    $('btnFollow').hidden = false;
  }
  window.addEventListener('wheel', userScrolled, { passive: true });
  window.addEventListener('touchmove', userScrolled, { passive: true });
  window.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) userScrolled();
  });
  $('btnFollow').addEventListener('click', () => {
    follow = true;
    $('btnFollow').hidden = true;
    scrollToUnit(speaker.idx);
  });

  // 縦書き: roda do mouse vertical -> rolagem horizontal
  reader.addEventListener('wheel', (e) => {
    if (!document.documentElement.classList.contains('vertical')) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      reader.scrollLeft -= e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });

  // Parado: guarda como posição a 1ª frase visível (o "聞く" começa dali)
  let scrollTimer = 0;
  function onScrollIdle() {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (speaker.playing || Date.now() - programmaticScroll < 800) return;
      const vertical = document.documentElement.classList.contains('vertical');
      const topLimit = 70;
      for (let i = 0; i < units.length; i++) {
        const r = units[i].el.getBoundingClientRect();
        const visible = vertical ? r.left < window.innerWidth - 20 && r.right > 0 && r.right <= window.innerWidth
                                 : r.bottom > topLimit;
        if (visible) {
          speaker.idx = i;
          JKS.saveLast(VOL, chNo, i);
          break;
        }
      }
    }, 400);
  }
  window.addEventListener('scroll', onScrollIdle, { passive: true });
  reader.addEventListener('scroll', onScrollIdle, { passive: true });

  // Marcar como lido: fim do capítulo visível depois de algum tempo na página
  let endObserver = null;
  function observeEnd() {
    if (endObserver) endObserver.disconnect();
    const end = reader.querySelector('.ch-end');
    if (!end || !('IntersectionObserver' in window)) return;
    endObserver = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting) && Date.now() - openedAt > 20000) {
        JKS.markRead(VOL, chNo);
        renderToc();
      }
    }, { threshold: 0.4 });
    endObserver.observe(end);
  }

  /* ---------- Cliques ---------- */
  reader.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) {
      JKS.markRead(VOL, chNo);
      openChapter(parseInt(go.dataset.go, 10), 0, true);
      reader.focus({ preventScroll: true });
      return;
    }
    const s = e.target.closest('.s');
    if (!s) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.toString().trim().length > 0) return;
    follow = true;
    $('btnFollow').hidden = true;
    speaker.play(parseInt(s.dataset.u, 10));   // tocar numa frase = ler dali
  });

  $('btnPlay').addEventListener('click', () => {
    if (!speaker.playing) { follow = true; scrollToUnit(speaker.idx); }
    speaker.toggle();
  });
  $('btnPrev').addEventListener('click', () => { speaker.prev(); if (!speaker.playing) scrollToUnit(speaker.idx); });
  $('btnNext').addEventListener('click', () => { speaker.next(); if (!speaker.playing) scrollToUnit(speaker.idx); });
  $('btnRate').addEventListener('click', () => {
    JKS.setSetting('rate', (JKS.settings.rate + 1) % JKS.RATES.length);
  });

  window.addEventListener('popstate', () => {
    const n = parseInt(new URLSearchParams(location.search).get('ch'), 10) || 1;
    if (n !== chNo) openChapter(n, 0, false);
  });

  /* ---------- Painéis ---------- */
  function openSheet(id) {
    const sh = $(id);
    sh.classList.add('open');
    const btn = sh.querySelector('[data-close].chip');
    if (btn) btn.focus();
  }
  function closeSheets() { document.querySelectorAll('.sheet.open').forEach(s => s.classList.remove('open')); }
  document.querySelectorAll('.sheet [data-close]').forEach(el => el.addEventListener('click', closeSheets));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });
  $('btnToc').addEventListener('click', () => openSheet('sheetToc'));
  $('btnSettings').addEventListener('click', () => openSheet('sheetSettings'));

  function renderToc() {
    const prog = JKS.getProgress(VOL);
    $('tocList').innerHTML = book.chapters.map((c, i) => {
      const n = i + 1;
      const m = JKS.readMinutes(JKS.chapterChars(c));
      const isRead = prog.read.includes(n);
      return '<li><a href="read.html?ch=' + n + '" data-ch="' + n + '" class="' + (isRead ? 'is-read' : '') + (n === chNo ? ' is-last' : '') + '"' +
        (n === chNo ? ' aria-current="page"' : '') + '>' +
        '<span class="num">' + (isRead ? '✓ ' : '') + '第' + n + '話</span>' +
        '<span class="ttl">' + JKS.escapeHtml(c.title) + '</span>' +
        '<span class="min">約' + m + '分</span></a></li>';
    }).join('');
  }
  $('tocList').addEventListener('click', (e) => {
    const a = e.target.closest('a[data-ch]');
    if (!a) return;
    e.preventDefault();
    closeSheets();
    openChapter(parseInt(a.dataset.ch, 10), 0, true);
  });

  /* ---------- Configurações ---------- */
  $('optSize').innerHTML = JKS.SIZE_LABELS.map((l, i) =>
    '<button type="button" data-val="' + i + '" style="font-size:' + (15 + i * 2) + 'px">' + l + '</button>').join('');
  $('optSize').dataset.key = 'size';
  $('optRate').innerHTML = JKS.RATE_LABELS.map((l, i) => '<button type="button" data-val="' + i + '">' + l + '</button>').join('');
  $('optRate').dataset.key = 'rate';

  function parseVal(key, v) {
    if (key === 'size' || key === 'rate') return parseInt(v, 10);
    if (v === 'true') return true;
    if (v === 'false') return false;
    return v;
  }
  document.querySelectorAll('.seg[data-key]').forEach(seg => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-val]');
      if (!b) return;
      JKS.setSetting(seg.dataset.key, parseVal(seg.dataset.key, b.dataset.val));
    });
  });

  function syncSettingsUI() {
    const st = JKS.settings;
    $('optEngineWrap').hidden = !AUDIO;
    $('optVoiceWrap').hidden = !!AUDIO && st.engine !== 'tts';
    document.querySelectorAll('.seg[data-key]').forEach(seg => {
      const cur = String(st[seg.dataset.key]);
      seg.querySelectorAll('button[data-val]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.val === cur)));
    });
    $('btnRate').innerHTML = '<small>速さ</small>' + JKS.RATE_LABELS[st.rate];
  }

  document.addEventListener('jks:settings', (e) => {
    const { key } = e.detail;
    syncSettingsUI();
    if (key === 'rate') [tts, narr].forEach(x => { if (x) x.setRate(JKS.RATES[JKS.settings.rate]); });
    if (key === 'voice') tts.setVoice(JKS.settings.voice);
    if (key === 'engine') {
      const i = speaker.idx;
      openChapter(chNo, i, false);
    }
    if (key === 'rate') {
      const k = reader.querySelector('.ch-kicker');
      if (k) { const m = chapterMeta(chNo); k.textContent = k.textContent.replace(/聞く 約\d+分/, '聞く 約' + m.listen + '分'); }
    }
    if (key === 'vertical' || key === 'size' || key === 'spacing' || key === 'font') {
      requestAnimationFrame(() => scrollToUnit(speaker.idx, true));
    }
  });

  function fillVoices(list) {
    list = list || JKSpeaker.voices();
    const sel = $('optVoice');
    if (!list.length) {
      sel.innerHTML = '<option value="">（日本語の声が見つかりません）</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = '<option value="">おまかせ（おすすめ）</option>' +
      list.map(v => '<option value="' + JKS.escapeHtml(v.voiceURI) + '">' + JKS.escapeHtml(v.name.replace(/^Microsoft\s+/, '')) + '</option>').join('');
    sel.value = list.some(v => v.voiceURI === JKS.settings.voice) ? JKS.settings.voice : '';
  }
  $('optVoice').addEventListener('change', (e) => JKS.setSetting('voice', e.target.value));

  /* ---------- Início ---------- */
  syncSettingsUI();
  fillVoices();
  renderToc();
  const q = new URLSearchParams(location.search);
  const last = JKS.getProgress(VOL).last;
  let startCh = parseInt(q.get('ch'), 10);
  let startS = parseInt(q.get('s'), 10) || 0;
  if (!startCh) { startCh = last ? last.ch : 1; startS = last ? last.s : 0; }
  openChapter(startCh, startS, false);
  if (q.get('listen') === '1') {
    $('btnPlay').classList.add('pulse');
    setMsg('「聞く」を押すと、読み上げが始まります。');
  }
})();
