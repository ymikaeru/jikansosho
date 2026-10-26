"""audio_pipeline.py — áudio narrado + karaokê sincronizado.

Passos (volume N):
  python -I scripts/audio_pipeline.py script 9
      Gera audio/volNN/script/chMM.txt = texto exato enviado ao TTS de cada
      capítulo (leituras do ruby + data/speech_fixes.json) e chMM.units.json
      com a posição de cada frase nesse texto e o mapa para os caracteres
      exibidos (o mesmo "k" que js/karaoke.js usa).
  (gerar os MP3 com o TTS e salvar em audio/volNN/chMM.mp3)
  python scripts/audio_pipeline.py align 9 [--model medium] [--only 3,4]
      Alinhamento forçado (stable-ts / Whisper) de cada MP3 com seu texto ->
      audio/volNN/align/chMM.json; depois grava data/volNN_audio.js.
  python -I scripts/audio_pipeline.py pack 9
      Só regrava data/volNN_audio.js a partir dos alinhamentos já feitos.

As unidades seguem exatamente a ordem do leitor (js/reader.js): título do
capítulo, depois cada frase de cada bloco (no waka, cada verso).
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'


def load_volume(vol):
    t = (DATA / ('vol%02d.js' % vol)).read_text(encoding='utf-8')
    return json.loads(t.split('] = ', 1)[1].rstrip().rstrip(';'))


def load_fixes(vol):
    p = DATA / 'speech_fixes.json'
    return json.loads(p.read_text(encoding='utf-8')).get(str(vol), {}) if p.exists() else {}


def prepare(segs):
    """Espelho de prepare() em js/karaoke.js: devolve (speak, kmap)."""
    speak, kmap, k = [], [], -1
    for seg in segs:
        if isinstance(seg, str):
            for c in seg:
                k += 1
                if c in '―—' or c in '　 ':
                    if not speak or speak[-1] != '、':
                        speak.append('、'); kmap.append(k)
                else:
                    speak.append(c); kmap.append(k)
        else:
            k += 1
            for c in seg[1]:
                speak.append(c); kmap.append(k)
    return ''.join(speak), kmap


def apply_fixes(speak, kmap, fixes):
    """Substitui trechos falados; os novos caracteres herdam os k do trecho velho."""
    for old, new in fixes.items():
        if old.startswith('_'):
            continue
        i = speak.find(old)
        while i >= 0:
            ks = kmap[i:i + len(old)]
            newk = [ks[min(len(ks) - 1, j * len(ks) // max(1, len(new)))] for j in range(len(new))]
            speak = speak[:i] + new + speak[i + len(old):]
            kmap = kmap[:i] + newk + kmap[i + len(old):]
            i = speak.find(old, i + len(new))
    return speak, kmap


def chapter_units(ch):
    """Lista de (segs, separador_depois) na ordem do leitor."""
    out = [([ch['title']], '。\n\n')]
    for b in ch['blocks']:
        n = len(b['s'])
        for j, s in enumerate(b['s']):
            if j < n - 1:
                sep = '\n' if b['t'] == 'waka' else ''
            else:
                sep = '\n\n'
            out.append((s, sep))
    return out


def build_script(vol, ch_no, ch, fixes):
    text, units = '', []
    for segs, sep in chapter_units(ch):
        speak, kmap = prepare(segs)
        speak, kmap = apply_fixes(speak, kmap, fixes)
        start = len(text)
        text += speak
        units.append({'start': start, 'end': len(text), 'kmap': kmap})
        text += sep
    return text.rstrip('\n'), units


def vol_dir(vol):
    return ROOT / 'audio' / ('vol%02d' % vol)


def cmd_script(vol):
    book = load_volume(vol)
    fixes = load_fixes(vol)
    out = vol_dir(vol) / 'script'
    out.mkdir(parents=True, exist_ok=True)
    total = 0
    for n, ch in enumerate(book['chapters'], 1):
        text, units = build_script(vol, n, ch, fixes)
        (out / ('ch%02d.txt' % n)).write_text(text, encoding='utf-8')
        (out / ('ch%02d.units.json' % n)).write_text(json.dumps(units, ensure_ascii=False), encoding='utf-8')
        total += len(text)
        print('ch%02d  %5d chars  %3d units  %s' % (n, len(text), len(units), ch['title']))
    print('total', total, 'chars')


def align_chapter(model, mp3, text):
    import stable_whisper  # noqa: import tardio (só no passo align)
    res = model.align(str(mp3), text, language='ja', original_split=True)
    words = []
    for seg in res.segments:
        for w in seg.words:
            words.append({'w': w.word, 's': round(w.start, 3), 'e': round(w.end, 3)})
    return words


def words_to_units(text, units, words):
    """Posiciona cada palavra alinhada no texto e gera, por unidade,
    o início e as marcas [k, tempo] para o preenchimento do karaokê."""
    # char -> tempo de início (da palavra que o contém)
    char_t = [None] * len(text)
    cur = 0
    for w in words:
        piece = w['w'].strip()
        if not piece:
            continue
        i = text.find(piece, cur)
        if i < 0 or i - cur > 40:
            # palavra normalizada pelo alinhador: avança pelo comprimento
            i = cur
        for j in range(i, min(len(text), i + len(piece))):
            if char_t[j] is None:
                char_t[j] = w['s']
        cur = i + len(piece)
    # preenche buracos com o último tempo conhecido
    last = 0.0
    for j in range(len(char_t)):
        if char_t[j] is None:
            char_t[j] = last
        else:
            last = char_t[j]
    out = []
    for u in units:
        if u['end'] <= u['start']:
            out.append([out[-1][0] if out else 0.0, []])
            continue
        t0 = char_t[u['start']]
        marks, prev_t = [], None
        for off in range(u['start'], u['end']):
            t = char_t[off]
            if t != prev_t:
                marks.append([u['kmap'][off - u['start']], round(t, 2)])
                prev_t = t
        out.append([round(t0, 2), marks])
    # tempos monotônicos entre unidades
    for i in range(1, len(out)):
        if out[i][0] < out[i - 1][0]:
            out[i][0] = out[i - 1][0]
    return out


def cmd_align(vol, model_name, only):
    import stable_whisper
    model = stable_whisper.load_model(model_name)
    d = vol_dir(vol)
    (d / 'align').mkdir(exist_ok=True)
    book = load_volume(vol)
    for n in range(1, len(book['chapters']) + 1):
        if only and n not in only:
            continue
        mp3 = d / ('ch%02d.mp3' % n)
        if not mp3.exists():
            print('ch%02d  sem mp3, pulando' % n)
            continue
        text = (d / 'script' / ('ch%02d.txt' % n)).read_text(encoding='utf-8')
        words = align_chapter(model, mp3, text)
        (d / 'align' / ('ch%02d.json' % n)).write_text(json.dumps(words, ensure_ascii=False), encoding='utf-8')
        print('ch%02d  %d palavras, fim %.1fs' % (n, len(words), words[-1]['e'] if words else 0))
    cmd_pack(vol)


def cmd_pack(vol):
    d = vol_dir(vol)
    book = load_volume(vol)
    meta_p = d / 'meta.json'
    meta = json.loads(meta_p.read_text(encoding='utf-8-sig')) if meta_p.exists() else {}
    chapters = {}
    for n in range(1, len(book['chapters']) + 1):
        al = d / 'align' / ('ch%02d.json' % n)
        if not al.exists():
            continue
        text = (d / 'script' / ('ch%02d.txt' % n)).read_text(encoding='utf-8')
        units = json.loads((d / 'script' / ('ch%02d.units.json' % n)).read_text(encoding='utf-8'))
        words = json.loads(al.read_text(encoding='utf-8'))
        chapters[n] = {
            'src': 'audio/vol%02d/ch%02d.mp3' % (vol, n),
            'dur': round(words[-1]['e'], 2) if words else 0,
            'u': words_to_units(text, units, words),
        }
    payload = {'voice': meta.get('voice', ''), 'chapters': chapters}
    js = ('/* gerado por scripts/audio_pipeline.py — não editar à mão */\n'
          'window.JIKAN_AUDIO = window.JIKAN_AUDIO || {};\n'
          'window.JIKAN_AUDIO[%d] = %s;\n') % (vol, json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
    out = DATA / ('vol%02d_audio.js' % vol)
    out.write_text(js, encoding='utf-8')
    print('gravado', out.relative_to(ROOT), '(%d capítulos, %d KB)' % (len(chapters), len(js.encode('utf-8')) // 1024))


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    cmd, vol = sys.argv[1], int(sys.argv[2])
    args = sys.argv[3:]
    if cmd == 'script':
        cmd_script(vol)
    elif cmd == 'align':
        model = args[args.index('--model') + 1] if '--model' in args else 'medium'
        only = set(int(x) for x in args[args.index('--only') + 1].split(',')) if '--only' in args else None
        cmd_align(vol, model, only)
    elif cmd == 'pack':
        cmd_pack(vol)
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main()
