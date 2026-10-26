/* home.js — página inicial: 続きから, progresso e lista de capítulos. */
(function () {
  'use strict';

  const VOL = 9;
  const book = window.JIKAN_VOLUMES && window.JIKAN_VOLUMES[VOL];
  const $ = (id) => document.getElementById(id);
  if (!book) return;

  const total = book.chapters.length;
  const prog = JKS.getProgress(VOL);

  $('date').textContent = book.date.replace(/発行$/, '');

  // 続きから: abre exatamente na frase onde parou
  if (prog.last) {
    const ch = book.chapters[prog.last.ch - 1];
    if (ch) {
      $('ctaRead').href = 'read.html?ch=' + prog.last.ch + '&s=' + (prog.last.s || 0);
      $('ctaReadLabel').textContent = '続きから読む';
      $('ctaListen').href = 'read.html?ch=' + prog.last.ch + '&s=' + (prog.last.s || 0) + '&listen=1';
      $('ctaSub').textContent = '前回：第' + prog.last.ch + '話「' + ch.title + '」';
    }
  } else {
    const first = JKS.readMinutes(JKS.chapterChars(book.chapters[0]));
    $('ctaSub').textContent = '第一話「' + book.chapters[0].title + '」は約' + first + '分で読めます。';
  }

  const nRead = prog.read.filter(n => n >= 1 && n <= total).length;
  if (nRead > 0) {
    $('progress').hidden = false;
    $('progressText').textContent = '全' + total + '話のうち ' + nRead + '話 読みました' + (nRead === total ? '。おめでとうございます！' : '');
    $('progressFill').style.width = Math.round(nRead / total * 100) + '%';
  }

  $('toc').innerHTML = book.chapters.map((c, i) => {
    const n = i + 1;
    const isRead = prog.read.includes(n);
    const isLast = prog.last && prog.last.ch === n;
    return '<li><a href="read.html?ch=' + n + '" class="' + (isRead ? 'is-read' : '') + (isLast ? ' is-last' : '') + '">' +
      '<span class="num">' + (isRead ? '✓ ' : '') + '第' + n + '話</span>' +
      '<span class="ttl">' + JKS.escapeHtml(c.title) + '</span>' +
      '<span class="min">約' + JKS.readMinutes(JKS.chapterChars(c)) + '分</span></a></li>';
  }).join('');
})();
