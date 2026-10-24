@echo off
chcp 65001 >nul
cd /d "%~dp0board"
start "" http://127.0.0.1:4317/
node server.mjs
pause
