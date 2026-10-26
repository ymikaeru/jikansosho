/* shelf.js — página inicial: um cartão por volume de data/library.js,
   com 続きから direto no cartão (um toque para voltar à leitura). */
(function () {
  'use strict';

  const shelf = document.getElementById('shelf');
  const esc = JKS.escapeHtml;

  shelf.innerHTML = JKS.library().map(v => {
    const prog = JKS.getProgress(v.vol);
    const nRead = prog.read.filter(n => n >= 1 && n <= v.chapters).length;
    const last = prog.last;
    const readHref = last
      ? 'read.html?vol=' + v.vol + '&ch=' + last.ch + (last.s ? '&s=' + last.s : '')
      : 'read.html?vol=' + v.vol + '&ch=1';
    const status = nRead === v.chapters ? '読了'
      : nRead > 0 ? '全' + v.chapters + '話のうち ' + nRead + '話 読了'
      : '全' + v.chapters + '話';
    return '<li class="vol-card">' +
      '<a class="vol-cover" href="volume.html?vol=' + v.vol + '"><img src="' + esc(v.cover) + '" alt="『' + esc(v.title) + '』表紙" loading="lazy"></a>' +
      '<div class="vol-body">' +
        '<p class="vol-num">' + esc(v.number) + (v.audio ? '<span class="badge">朗読つき</span>' : '') + '</p>' +
        '<h2 class="vol-title"><a href="volume.html?vol=' + v.vol + '">' + esc(v.title) + '</a></h2>' +
        '<p class="vol-meta">' + esc(v.date) + '</p>' +
        '<p class="vol-status">' + status + '</p>' +
        (nRead > 0 ? '<div class="progress-bar" aria-hidden="true"><span style="width:' + Math.round(nRead / v.chapters * 100) + '%"></span></div>' : '') +
        '<div class="vol-actions">' +
          '<a class="btn btn-primary" href="' + readHref + '">' + (last ? '続きから読む' : '読む') + '</a>' +
          '<a class="btn" href="volume.html?vol=' + v.vol + '">目次</a>' +
        '</div>' +
      '</div>' +
    '</li>';
  }).join('');
})();
