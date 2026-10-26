# 自観叢書 — leitura fácil

Site para baixar a barreira de entrada aos Ensinamentos de Meishu-sama, pensado para leitores japoneses nativos que têm dificuldade de começar ou continuar a leitura (falta de tempo, cansaço, vista cansada).

Começa com o volume 9, 「光への道」 (21 capítulos).

## O que o site oferece

- Um capítulo por tela, com o tempo estimado de leitura e de escuta (「読む 約3分・聞く 約4分」).
- 「続きから読む」: volta exatamente à frase onde a pessoa parou.
- Progresso visível: capítulos lidos marcados ✓ e barra de progresso.
- Letra grande (fontes BIZ UD), 4 temas de cor, 縦書き, e furigana tirada das leituras do próprio original.
- **Narração (朗読)** com karaokê: a frase atual fica destacada e as palavras são preenchidas à medida que são lidas. Continua tocando com a tela apagada e passa sozinha para o próximo capítulo.
- Voz do sistema (Web Speech API) como alternativa.

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `index.html` + `js/shelf.js` | estante: um cartão por volume, com 続きから |
| `volume.html?vol=N` + `js/volume.js` | capa e índice de um volume |
| `read.html?vol=N&ch=M` | leitor |
| `data/library.js` | lista de volumes publicados (para adicionar um volume, inclua uma linha aqui) |
| `js/common.js` | configurações, progresso, volume da URL, utilitários |
| `js/reader.js` | leitor (capítulos, configurações, rolagem que acompanha a leitura) |
| `js/karaoke.js` | `AudioPlayer` (MP3 + tempos) e `Speaker` (voz do sistema) |
| `data/vol09.js` | texto do volume, gerado |
| `data/vol09_audio.js` | tempos por frase e por palavra, gerados |
| `data/text_corrections.json` | erros de digitação do original corrigidos na tela |
| `data/ruby_overrides.json` | ajustes da base de cada furigana |
| `data/speech_fixes.json` | ajustes de pronúncia **só para a voz** |
| `audio/vol09/chNN.mp3` | narração (ElevenLabs v4, voz Haruto Nakagawa) |
| `audio/vol09/script/` | texto exato enviado ao TTS de cada capítulo |
| `audio/vol09/align/` | alinhamento por palavra (stable-ts) |

## Rodar localmente

Dois cliques em `INICIAR.bat`, ou rode no terminal:

```bash
python scripts/serve.py 8010
```

O `serve.py` aceita pedidos com Range. Sem isso, o navegador não consegue pular para outro ponto do áudio.

## Pipeline

As fontes ficam em `source/`, que só existe na máquina local e não vai para o repositório. Elas são copiadas do `new_mioshie_zenshu`.

```bash
# 1. Texto: HTML legado -> data/vol09.js (com --check, compara com o JSON do zenshu)
python -I scripts/build_volume.py 9 --check --ruby

# 2. Texto falado de cada capítulo (leituras + speech_fixes) -> audio/vol09/script/
python -I scripts/audio_pipeline.py script 9

# 3. Gerar os MP3 com o TTS a partir de audio/vol09/script/chNN.txt -> audio/vol09/chNN.mp3

# 4. Alinhamento forçado (stable-ts, usa a GPU se houver) -> data/vol09_audio.js
python scripts/audio_pipeline.py align 9            # todos os capítulos
python scripts/audio_pipeline.py align 9 --only 5   # só um capítulo
```

Para achar e corrigir palavras lidas errado sem regravar capítulos inteiros:

```bash
# 1. Checagem: o Whisper ouve cada frase e compara a leitura em kana -> audio/vol09/qa/report.txt
python scripts/qa_audio.py 9

# 2. Depois de acrescentar as leituras certas em data/speech_fixes.json:
python -I scripts/audio_pipeline.py diff 9     # lista as frases afetadas -> patches/todo.json

# 3. Gere o TTS de cada "text" de todo.json em audio/vol09/patches/<file>

# 4. Emenda no MP3, atualiza o script e realinha
python scripts/audio_pipeline.py splice 9
```
