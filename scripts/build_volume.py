"""build_volume.py — legacy HTML do 自観叢書 -> data/volNN.js

Uso:  python -I scripts/build_volume.py 9 [--check] [--ruby]

Lê source/legacy/sosyoNN.html (estrutura do site legado: cabeçalhos em
<strong>, uma linha por <br>), separa capítulos / parágrafos / waka / notas /
奥付, converte as leituras do original 漢字（かな） em ruby e divide em frases
(unidade do karaokê). Grava data/volNN.js como window.JIKAN_VOLUMES[N].

--check  compara o texto extraído com source/json/teachings_pub_sasshi_sosyoNN.json
--ruby   lista todos os pares ruby (para revisar a base de cada leitura)
"""
import difflib
import html
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LEGACY = ROOT / 'source' / 'legacy'
JSONDIR = ROOT / 'source' / 'json'
OUT = ROOT / 'data'

KANJI = r'㐀-䶿一-鿿豈-﫿々〆ヶケ'
KANA = r'ぁ-ゖァ-ヺー'
# 漢字の連続 + （かなのみ）
RUBY_RE = re.compile(r'([' + KANJI + r']+)（([' + KANA + r']+)）')
SENT_END = '。！？!?'
CLOSERS = '」』）)"”'


def load_overrides():
    p = OUT / 'ruby_overrides.json'
    if p.exists():
        return json.loads(p.read_text(encoding='utf-8'))
    return {}


def load_corrections(vol):
    """Erros de digitação do original corrigidos de propósito (data/text_corrections.json)."""
    p = OUT / 'text_corrections.json'
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding='utf-8')).get(str(vol), {})


def apply_corrections(text, corrections):
    for old, new in corrections.items():
        text = text.replace(old, new)
    return text


def ruby_base(run, reading, overrides):
    """Escolhe quantos kanji do fim do run a leitura cobre."""
    key = run + '（' + reading + '）'
    if key in overrides:
        base = overrides[key]
        if not run.endswith(base):
            raise ValueError('override inválido: %s -> %s' % (key, base))
        return base
    # menor sufixo que comporte a leitura (~2.5 kana por kanji),
    # sem começar por 々 / ヶ
    n = len(reading)
    for size in range(1, len(run) + 1):
        base = run[-size:]
        if base[0] in '々ヶケ〆':
            continue
        if size * 2.5 >= n:
            return base
    return run


def to_segments(text, overrides, ruby_log):
    """Texto -> lista de segmentos: str ou [base, leitura]."""
    segs = []
    pos = 0
    for m in RUBY_RE.finditer(text):
        run, reading = m.group(1), m.group(2)
        base = ruby_base(run, reading, overrides)
        lead = run[:len(run) - len(base)]
        before = text[pos:m.start()] + lead
        if before:
            segs.append(before)
        segs.append([base, reading])
        ruby_log.append((run, base, reading))
        pos = m.end()
    if pos < len(text):
        segs.append(text[pos:])
    return segs


def split_sentences(text):
    """Divide após 。！？ mantendo os fechamentos 」』） junto da frase."""
    out, buf, i = [], '', 0
    while i < len(text):
        ch = text[i]
        buf += ch
        i += 1
        if ch in SENT_END:
            while i < len(text) and text[i] in CLOSERS + SENT_END:
                buf += text[i]
                i += 1
            out.append(buf)
            buf = ''
    if buf.strip():
        out.append(buf)
    return out


def sentences_of(text, overrides, ruby_log):
    # A ruby nunca atravessa o fim de frase, então pode dividir antes.
    return [to_segments(s, overrides, ruby_log) for s in split_sentences(text)]


def raw_lines(src):
    """HTML legado -> lista de (linha, is_heading, is_note)."""
    body = src.split('<blockquote>', 1)[1].split('</blockquote>', 1)[0]
    # o FrontPage quebra linhas no meio; [ \t] e não \s, que comeria o recuo
    body = re.sub(r'\r?\n[ \t]*', '', body)
    body = re.sub(r'</p>', '<br>', body)          # banner fica em <p> próprio
    # marca notas (font size=2) e cabeçalhos antes de remover as tags
    body = re.sub(r'<font size="2"[^>]*>(.*?)</font>',
                  lambda m: re.sub(r'<br>', '<br>\x02', '\x02' + m.group(1)), body, flags=re.S)
    body = re.sub(r'<strong>(.*?)</strong>',
                  lambda m: '\x01' + m.group(1).replace('<br>', '') + '<br>', body, flags=re.S)
    lines = []
    for part in body.split('<br>'):
        is_note = '\x02' in part
        is_head = '\x01' in part
        txt = html.unescape(re.sub(r'<[^>]+>', '', part)).replace('\x01', '').replace('\x02', '')
        lines.append((txt, is_head, is_note))
    return lines


def build(vol):
    src = (LEGACY / ('sosyo%02d.html' % vol)).read_text(encoding='utf-8')
    overrides = load_overrides()
    ruby_log = []
    corrections = load_corrections(vol)
    lines = [(apply_corrections(t, corrections), h, n) for t, h, n in raw_lines(src)]

    meta = {'volume': vol, 'cover': 'img/covers/jikan%d.JPG' % vol}
    chapters, colophon = [], []
    cur = None
    in_colophon = False
    i = 0
    header_done = False
    while i < len(lines):
        txt, is_head, is_note = lines[i]
        stripped = txt.strip(' 　')
        i += 1
        if not stripped:
            continue
        if '論 文 集' in stripped:
            continue                              # banner 岡田自観師の論文集
        if not header_done and is_head and not chapters and 'title' not in meta:
            meta['title'] = stripped
            continue
        if not header_done and not is_head and not chapters:
            m = re.match(r'(自観叢書第\S+?篇)『(.+?)』(.+)$', stripped)
            if m:
                meta['series'] = m.group(1)
                meta['date'] = m.group(3)
                continue
        if re.match(r'^自観叢書第[０-９\d]+篇$', stripped) and chapters:
            in_colophon = True
        if in_colophon:
            colophon.append(re.sub(r'　+', '　', stripped))
            continue
        if is_head:
            header_done = True
            cur = {'title': stripped, 'blocks': []}
            chapters.append(cur)
            continue
        if cur is None:
            raise ValueError('texto antes do 1º capítulo: ' + stripped[:40])
        # waka: linha seguida de outra recuada com muitos espaços largos
        nxt = lines[i][0] if i < len(lines) else ''
        if re.match(r'^　{4,}', nxt) and len(stripped) <= 40:
            second = nxt.strip(' 　')
            i += 1
            cur['blocks'].append({'t': 'waka', 's': [
                to_segments(stripped, overrides, ruby_log),
                to_segments(second, overrides, ruby_log)]})
            continue
        block = {'t': 'note' if is_note else 'p',
                 's': sentences_of(stripped, overrides, ruby_log)}
        if txt.startswith('　'):
            block['i'] = 1                        # recuo de parágrafo do original
        cur['blocks'].append(block)

    meta['chapters'] = chapters
    meta['colophon'] = colophon
    return meta, ruby_log, lines


def flat_text(meta):
    """Texto puro (para comparar com o JSON), na ordem do livro."""
    def segs(ss):
        return ''.join(s if isinstance(s, str) else s[0] + '（' + s[1] + '）' for s in ss)
    parts = [meta.get('title', ''), meta.get('series', '') + '『' + meta.get('title', '') + '』' + meta.get('date', '')]
    for ch in meta['chapters']:
        parts.append(ch['title'])
        for b in ch['blocks']:
            parts.extend(segs(s) for s in b['s'])
    parts.extend(meta['colophon'])
    return ''.join(parts)


def norm(s):
    return re.sub(r'[\s　]+', '', s)


def check(vol, meta):
    data = json.loads((JSONDIR / ('teachings_pub_sasshi_sosyo%02d.json' % vol)).read_text(encoding='utf-8'))
    # o JSON tem os mesmos erros do original: aplica as mesmas correções antes de comparar
    ref = norm(apply_corrections(data[0]['content'], load_corrections(vol)))
    got = norm(flat_text(meta))
    if ref == got:
        print('CHECK OK: texto idêntico ao JSON (%d caracteres)' % len(ref))
        return True
    print('CHECK: diferenças (JSON -> extraído):')
    sm = difflib.SequenceMatcher(None, ref, got, autojunk=False)
    for op, a1, a2, b1, b2 in sm.get_opcodes():
        if op != 'equal':
            print('  %s @%d  %r -> %r   …%s…' % (op, a1, ref[a1:a2], got[b1:b2], ref[max(0, a1 - 12):a2 + 12]))
    return False


def main():
    args = sys.argv[1:]
    vol = int(args[0])
    sys.stdout.reconfigure(encoding='utf-8')
    meta, ruby_log, _ = build(vol)
    if 'title' not in meta or 'series' not in meta:
        raise SystemExit('cabeçalho não reconhecido')

    nblocks = sum(len(c['blocks']) for c in meta['chapters'])
    nsent = sum(len(b['s']) for c in meta['chapters'] for b in c['blocks'])
    print('%s %s — %s' % (meta['series'], meta['title'], meta['date']))
    print('capítulos: %d  blocos: %d  frases: %d  ruby: %d' % (len(meta['chapters']), nblocks, nsent, len(ruby_log)))
    for n, c in enumerate(meta['chapters'], 1):
        print('  %2d. %s' % (n, c['title']))

    if '--ruby' in args:
        for run, base, reading in ruby_log:
            flag = '' if run == base else '   (run: %s)' % run
            print('  ruby  %s / %s%s' % (base, reading, flag))
    if '--check' in args:
        check(vol, meta)

    OUT.mkdir(exist_ok=True)
    js = ('/* gerado por scripts/build_volume.py — não editar à mão */\n'
          'window.JIKAN_VOLUMES = window.JIKAN_VOLUMES || {};\n'
          'window.JIKAN_VOLUMES[%d] = %s;\n') % (vol, json.dumps(meta, ensure_ascii=False, separators=(',', ':')))
    path = OUT / ('vol%02d.js' % vol)
    path.write_text(js, encoding='utf-8')
    print('gravado', path.relative_to(ROOT), '(%d KB)' % (len(js.encode('utf-8')) // 1024))


if __name__ == '__main__':
    main()
