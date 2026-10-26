"""qa_audio.py — procura erros de pronúncia na narração.

Para cada frase, transcreve o trecho de áudio com o Whisper e compara a
LEITURA (hiragana, via pykakasi) do que foi ouvido com a leitura do texto
enviado ao TTS. Comparar em kana elimina as diferenças de kanji entre
homófonos; o que sobra são, em geral, leituras erradas (ex.: 見真実 lido
como しんじつ) ou trechos pulados.

Uso: python scripts/qa_audio.py 9 [--model large-v3] [--only 1,4]
Saída: audio/volNN/qa/report.txt (e um resumo no terminal)
"""
import difflib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

KATA = str.maketrans({chr(c): chr(c - 0x60) for c in range(0x30A1, 0x30F7)})


def kanji_num(m):
    """'38' -> '三十八' (o Whisper escreve números em algarismos; o texto, em kanji)."""
    n = int(m.group(0))
    if n == 0 or n >= 100000:
        return m.group(0)
    digits = '〇一二三四五六七八九'
    out = ''
    for value, name in ((10000, '万'), (1000, '千'), (100, '百'), (10, '十')):
        q, n = divmod(n, value)
        if q:
            out += ('' if q == 1 and value != 10000 else digits[q]) + name
    if n:
        out += digits[n]
    return out


def kana(text, kks):
    text = re.sub(r'\d+', kanji_num, text.translate(str.maketrans('０１２３４５６７８９', '0123456789')))
    s = ''.join(item['hira'] for item in kks.convert(text))
    s = s.translate(KATA)
    # só hiragana e ー: pontuação, espaços e números ficam de fora da comparação
    return re.sub(r'[^ぁ-ゖー]', '', s)


def main():
    import pykakasi
    import whisper
    sys.stdout.reconfigure(encoding='utf-8')
    args = sys.argv[1:]
    vol = int(args[0])
    model_name = args[args.index('--model') + 1] if '--model' in args else 'large-v3'
    only = set(int(x) for x in args[args.index('--only') + 1].split(',')) if '--only' in args else None

    d = ROOT / 'audio' / ('vol%02d' % vol)
    t = (ROOT / 'data' / ('vol%02d_audio.js' % vol)).read_text(encoding='utf-8')
    timing = json.loads(t.split('] = ', 1)[1].rstrip().rstrip(';'))['chapters']

    kks = pykakasi.kakasi()
    model = whisper.load_model(model_name)
    (d / 'qa').mkdir(exist_ok=True)
    out = []
    flagged = 0
    for n in sorted(int(k) for k in timing):
        if only and n not in only:
            continue
        c = timing[str(n)]
        text = (d / 'script' / ('ch%02d.txt' % n)).read_text(encoding='utf-8')
        units = json.loads((d / 'script' / ('ch%02d.units.json' % n)).read_text(encoding='utf-8'))
        audio = whisper.load_audio(str(d / ('ch%02d.mp3' % n)))
        starts = [u[0] for u in c['u']] + [c['dur'] + 0.5]
        for i, u in enumerate(units):
            a, b = starts[i], starts[i + 1]
            seg = audio[int(max(0, a - 0.15) * 16000):int((b + 0.1) * 16000)]
            if len(seg) < 1600:
                continue
            heard = model.transcribe(seg, language='ja', temperature=0,
                                     condition_on_previous_text=False, fp16=True)['text']
            want = text[u['start']:u['end']]
            kw, kh = kana(want, kks), kana(heard, kks)
            sm = difflib.SequenceMatcher(None, kw, kh, autojunk=False)
            diffs = []
            for op, a1, a2, b1, b2 in sm.get_opcodes():
                if op == 'equal':
                    continue
                if max(a2 - a1, b2 - b1) < 2:
                    continue
                diffs.append('%s「%s」→「%s」 …%s…' % (op, kw[a1:a2], kh[b1:b2], kw[max(0, a1 - 6):a2 + 6]))
            if diffs:
                flagged += 1
                out.append('ch%02d u%02d  %.1fs  (%.0f%%)  %s' % (n, i, a, sm.ratio() * 100, want))
                out.append('    ouvido: ' + heard.strip())
                out.extend('    ' + x for x in diffs)
        print('ch%02d ok' % n, flush=True)
    rep = d / 'qa' / 'report.txt'
    rep.write_text('\n'.join(out), encoding='utf-8')
    print('frases com diferença: %d  ->  %s' % (flagged, rep.relative_to(ROOT)))


if __name__ == '__main__':
    main()
