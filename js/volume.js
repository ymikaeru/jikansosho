/* volume.js — página de um volume (volume.html?vol=N): 続きから, progresso e índice. */
(function () {
  'use strict';

  const VOL = JKS.currentVol();
  const meta = JKS.volMeta(VOL) || {};
  const book = window.JIKAN_VOLUMES && window.JIKAN_VOLUMES[VOL];
  const $ = (id) => document.getElementById(id);
  if (!book) return;

  const total = book.chapters.length;
  const prog = JKS.getProgress(VOL);
  const readUrl = (ch, s, listen) => 'read.html?vol=' + VOL + '&ch=' + ch + (s ? '&s=' + s : '') + (listen ? '&listen=1' : '');

  document.title = book.title + '｜自観叢書';
  $('cover').src = book.cover;
  $('cover').alt = '『' + book.title + '』表紙';
  $('series').textContent = '自観叢書 ' + (meta.number || book.series);
  $('bookTitle').textContent = book.title;
  $('date').textContent = book.date.replace(/発行$/, '');

  // 続きから: abre exatamente na frase onde parou
  const last = prog.last && book.chapters[prog.last.ch - 1] ? prog.last : null;
  if (last) {
    $('ctaRead').href = readUrl(last.ch, last.s);
    $('ctaReadLabel').textContent = '続きから読む';
    $('ctaListen').href = readUrl(last.ch, last.s, true);
    $('ctaSub').textContent = '前回：第' + last.ch + '話「' + book.chapters[last.ch - 1].title + '」';
  } else {
    $('ctaRead').href = readUrl(1);
    $('ctaListen').href = readUrl(1, 0, true);
  }

  const nRead = prog.read.filter(n => n >= 1 && n <= total).length;
  if (nRead > 0) {
    $('progress').hidden = false;
    $('progressText').textContent = '全' + total + '話のうち ' + nRead + '話 読了';
    $('progressFill').style.width = Math.round(nRead / total * 100) + '%';
  }

  $('toc').innerHTML = book.chapters.map((c, i) => {
    const n = i + 1;
    const isRead = prog.read.includes(n);
    const isLast = last && last.ch === n;
    return '<li><a href="' + readUrl(n) + '" class="' + (isRead ? 'is-read' : '') + (isLast ? ' is-last' : '') + '">' +
      '<span class="num">' + (isRead ? '✓ ' : '') + '第' + n + '話</span>' +
      '<span class="ttl">' + JKS.escapeHtml(c.title) + '</span>' +
      '<span class="min">約' + JKS.readMinutes(JKS.chapterChars(c)) + '分</span></a></li>';
  }).join('');
})();
