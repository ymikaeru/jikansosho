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

Corrigir a pronúncia de algumas frases sem regravar o capítulo:
  1. ajustar data/speech_fixes.json
  2. python -I scripts/audio_pipeline.py diff 9   -> patches/todo.json
  3. gerar o TTS de cada "text" do todo.json em patches/<file>
  4. python scripts/audio_pipeline.py splice 9   (emenda, atualiza script, realinha)
  (scripts/qa_audio.py ajuda a achar as leituras erradas)

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


def word_spans(text, words):
    """Posição de cada palavra alinhada no texto: [(ini, fim, t_ini, t_fim)]."""
    spans, cur = [], 0
    for w in words:
        piece = w['w'].strip()
        if not piece:
            continue
        i = text.find(piece, cur)
        if i < 0 or i - cur > 40:
            i = cur
        spans.append((i, i + len(piece), w['s'], w['e']))
        cur = i + len(piece)
    return spans


def cmd_diff(vol):
    """Compara o texto gravado (audio/volNN/script) com o texto atual
    (vol + speech_fixes) e lista as frases que precisam ser regravadas
    -> audio/volNN/patches/todo.json"""
    book = load_volume(vol)
    fixes = load_fixes(vol)
    d = vol_dir(vol)
    todo = []
    for n, ch in enumerate(book['chapters'], 1):
        old_text = (d / 'script' / ('ch%02d.txt' % n)).read_text(encoding='utf-8')
        old_units = json.loads((d / 'script' / ('ch%02d.units.json' % n)).read_text(encoding='utf-8'))
        new_text, new_units = build_script(vol, n, ch, fixes)
        if len(old_units) != len(new_units):
            raise SystemExit('ch%02d: número de frases mudou; regrave o capítulo inteiro' % n)
        for i, (ou, nu) in enumerate(zip(old_units, new_units)):
            old = old_text[ou['start']:ou['end']]
            new = new_text[nu['start']:nu['end']]
            if old != new:
                speak = new + ('。' if i == 0 else '')   # o título é falado com 。
                todo.append({'ch': n, 'u': i, 'old': old, 'text': speak,
                             'file': 'ch%02d_u%02d.mp3' % (n, i)})
    (d / 'patches').mkdir(exist_ok=True)
    (d / 'patches' / 'todo.json').write_text(json.dumps(todo, ensure_ascii=False, indent=1), encoding='utf-8')
    for t in todo:
        print('ch%02d u%02d  %s' % (t['ch'], t['u'], t['text']))
    print('%d frases a regravar -> audio/vol%02d/patches/todo.json' % (len(todo), vol))


SIL_DB = -50.0      # abaixo disto o quadro conta como silêncio
SIL_MIN = 0.12      # duração mínima de uma pausa entre frases (s)
FRAME = 0.02


def load_db(mp3):
    """Energia em dB por quadro de 20 ms (via ffmpeg, 16 kHz mono)."""
    import subprocess
    import numpy as np
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(mp3), '-f', 's16le', '-ac', '1', '-ar', '16000', '-'],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, np.int16).astype(np.float32) / 32768
    n = int(16000 * FRAME)
    frames = x[:len(x) // n * n].reshape(-1, n)
    return 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9)


def silent_runs(db, t0, t1):
    """Pausas [(ini, fim)] em segundos dentro de [t0, t1]."""
    runs, start = [], None
    i0, i1 = max(0, int(t0 / FRAME)), min(len(db), int(t1 / FRAME))
    for i in range(i0, i1):
        if db[i] < SIL_DB:
            start = i if start is None else start
        else:
            if start is not None and (i - start) * FRAME >= SIL_MIN:
                runs.append((start * FRAME, i * FRAME))
            start = None
    if start is not None and (i1 - start) * FRAME >= SIL_MIN:
        runs.append((start * FRAME, i1 * FRAME))
    return runs


def _best_pause(runs, edge, t):
    """Pausa entre frases: a mais longa perto de t (as de vírgula são curtas,
    ~0.1 s; as depois de 。 passam de 0.4 s), com penalidade pela distância."""
    return max(runs, key=lambda r: (r[1] - r[0]) - 0.25 * abs(r[edge] - t))


def speech_bounds(db, a, b, first=False):
    """Início/fim REAIS da fala de uma frase. O alinhamento pode errar alguns
    décimos (ex.: marcou 以上 em 169.72 s quando a fala começa em 169.3 s), e
    cortar ali deixava pedaços da gravação antiga; no fim, o erro pode ser
    para os dois lados (cap. 4: alinhado 41.58 s, pausa real 41.00–41.50 s e
    a frase seguinte já em 41.52 s). Por isso procura dos dois lados a pausa
    de fim de frase (_best_pause) e corta dentro dela. A 1ª frase do capítulo
    (título) começa no início do arquivo, sem silêncio antes."""
    # Janelas estreitas: a pausa é recortada pela janela, então mesmo que ela
    # comece fora, o corte cai dentro dela; e pausas internas longas (versos de
    # waka lidos devagar) ficam de fora.
    before = [r for r in silent_runs(db, a - 0.8, a + 0.8) if not first]
    start = _best_pause(before, 1, a)[1] - 0.04 if before else (0.0 if first else a - 0.3)
    after = [r for r in silent_runs(db, b - 0.8, b + 1.2) if r[0] > start + 0.3]
    end = _best_pause(after, 0, b)[0] + 0.04 if after else b + 0.3
    return max(0.0, start), end


def cmd_splice(vol):
    """Troca no MP3 do capítulo o trecho de cada frase listada em todo.json
    pelo áudio regravado (patches/chMM_uKK.mp3). O corte é feito nas pausas
    reais em volta da frase (speech_bounds), mantendo o silêncio original de
    antes e de depois. Guarda o MP3 anterior em _partes/, atualiza o script e
    realinha os capítulos alterados."""
    import subprocess
    d = vol_dir(vol)
    todo = json.loads((d / 'patches' / 'todo.json').read_text(encoding='utf-8'))
    by_ch = {}
    for t in todo:
        if not (d / 'patches' / t['file']).exists():
            raise SystemExit('falta o áudio ' + t['file'])
        by_ch.setdefault(t['ch'], []).append(t)
    (d / '_partes').mkdir(exist_ok=True)
    for n, items in sorted(by_ch.items()):
        text = (d / 'script' / ('ch%02d.txt' % n)).read_text(encoding='utf-8')
        units = json.loads((d / 'script' / ('ch%02d.units.json' % n)).read_text(encoding='utf-8'))
        words = json.loads((d / 'align' / ('ch%02d.json' % n)).read_text(encoding='utf-8'))
        spans = word_spans(text, words)
        mp3 = d / ('ch%02d.mp3' % n)
        src = d / '_partes' / ('ch%02d_antes_emenda.mp3' % n)
        src.write_bytes(mp3.read_bytes())
        db = load_db(src)
        # trechos: [original até a pausa antes da frase] [regravação] [original da pausa depois em diante]
        inputs = ['-i', str(src)]
        filters, labels, pos = [], [], 0.0
        for k, t in enumerate(sorted(items, key=lambda x: x['u'])):
            # "through": a regravação cobre várias frases seguidas (ex.: os dois
            # versos de um waka, lidos sem pausa entre eles)
            u = {'start': units[t['u']]['start'], 'end': units[t.get('through', t['u'])]['end']}
            inside = [s for s in spans if u['start'] <= s[0] < u['end']]
            a = min(s[2] for s in inside)                 # início alinhado da frase
            b = max(s[3] for s in inside)                 # fim alinhado da frase
            cut_in, cut_out = speech_bounds(db, a, b, first=(t['u'] == 0))
            cut_in = max(pos, cut_in)
            filters.append('[0:a]atrim=%.3f:%.3f,asetpts=PTS-STARTPTS[o%d]' % (pos, cut_in, k))
            inputs += ['-i', str(d / 'patches' / t['file'])]
            filters.append('[%d:a]aresample=44100,aformat=channel_layouts=mono,'
                           'silenceremove=start_periods=1:start_threshold=-45dB,areverse,'
                           'silenceremove=start_periods=1:start_threshold=-45dB,areverse[p%d]' % (k + 1, k))
            labels += ['[o%d]' % k, '[p%d]' % k]
            print('   u%02d  corte %.2f–%.2f  (alinhado %.2f–%.2f)' % (t['u'], cut_in, cut_out, a, b))
            pos = cut_out
        filters.append('[0:a]atrim=start=%.3f,asetpts=PTS-STARTPTS[tail]' % pos)
        labels.append('[tail]')
        filters.append('%sconcat=n=%d:v=0:a=1[out]' % (''.join(labels), len(labels)))
        cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y'] + inputs + [
            '-filter_complex', ';'.join(filters), '-map', '[out]',
            '-c:a', 'libmp3lame', '-b:a', '128k', str(mp3)]
        subprocess.run(cmd, check=True)
        print('ch%02d  %d frase(s) emendada(s)' % (n, len(items)))
    # o texto gravado passa a ser o atual
    cmd_script(vol)
    return sorted(by_ch)


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    cmd, vol = sys.argv[1], int(sys.argv[2])
    args = sys.argv[3:]
    if cmd == 'script':
        cmd_script(vol)
    elif cmd == 'diff':
        cmd_diff(vol)
    elif cmd == 'splice':
        chs = cmd_splice(vol)
        model = args[args.index('--model') + 1] if '--model' in args else 'medium'
        if chs:
            cmd_align(vol, model, set(chs))
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
