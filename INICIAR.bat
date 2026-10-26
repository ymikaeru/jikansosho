@echo off
chcp 65001 > nul
title Jikan Sosho - leitura facil
cd /d "%~dp0"

echo ============================================================
echo    JIKAN SOSHO - servidor local
echo ============================================================
echo.

REM O site tambem abre direto pelo index.html (os dados estao em data\*.js),
REM mas o servidor local evita restricoes do navegador com file://.
where python >nul 2>nul
if errorlevel 1 (
    echo Python nao encontrado - abrindo o index.html direto.
    start "" "%~dp0index.html"
    exit /b 0
)

echo Iniciando servidor em http://localhost:8010 ...
echo Para fechar, feche esta janela.
echo.
start "" cmd /c "timeout /t 2 /nobreak > nul && start http://localhost:8010/"
REM serve.py aceita Range: sem isso nao da para pular dentro do audio
python scripts\serve.py 8010

pause
