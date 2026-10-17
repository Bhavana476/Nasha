@echo off
rem Starts the Nasha website and admin panel on this computer. Keep this window open while in use.
title Nasha Resto Bar - website server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul
if not errorlevel 1 (
  echo The Nasha server is already running. Opening it in your browser...
  start "" http://localhost:5173/admin/
  timeout /t 4 >nul
  exit /b 0
)
echo Starting Nasha... the website will open in your browser.
echo Close this window to stop the website.
echo.
start "" /b cmd /c "timeout /t 3 >nul & start http://localhost:5173/ & start http://localhost:5173/admin/"
node serve.mjs
echo.
echo The server has stopped.
pause
