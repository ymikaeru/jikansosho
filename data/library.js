/* library.js — volumes disponíveis no site (ordem da estante).
   Para adicionar um volume: gerar data/volNN.js (scripts/build_volume.py),
   opcionalmente o áudio (scripts/audio_pipeline.py -> data/volNN_audio.js),
   e incluir uma linha aqui. */
window.JIKAN_LIBRARY = [
  {
    vol: 9,
    number: '第九篇',
    title: '光への道',
    date: '昭和24年12月30日',
    cover: 'img/covers/jikan9.JPG',
    chapters: 21,
    audio: true,
  },
];
