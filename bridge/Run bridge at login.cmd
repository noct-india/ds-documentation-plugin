@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Claude bridge - login item

rem  Double-click to make the bridge start every time you log in - or, if it
rem  already does, to stop it. The same file both ways round, so there is one
rem  thing to find. This is the Windows equivalent of "Run bridge at login.command".
rem
rem  An idle bridge costs nothing: it only runs Claude when the plugin actually
rem  asks for drafts. That is what makes always-on reasonable rather than wasteful.

cd /d "%~dp0"

set "TASK=NOCT DS Bridge"
set "PORT=%DSDOC_BRIDGE_PORT%"
if not defined PORT set "PORT=8473"

if not exist "server.mjs" (
  echo Can't find server.mjs next to this file.
  echo Expected it in: %~dp0
  echo.
  pause
  exit /b 1
)

if not exist "run-hidden.vbs" (
  echo Can't find run-hidden.vbs next to this file - it starts the bridge without
  echo a window. Keep both files together in the bridge\ folder.
  echo.
  pause
  exit /b 1
)

rem  --- Find node -------------------------------------------------------------
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE (
  echo Node isn't installed, or isn't on the PATH this window can see.
  echo Install it from https://nodejs.org, then try again.
  echo.
  pause
  exit /b 1
)

rem  --- Already installed?  Then this is the off switch -----------------------
schtasks /query /tn "%TASK%" >nul 2>&1
if not errorlevel 1 (
  echo The bridge currently starts at login.
  echo   task: %TASK%
  echo   log:  %LOCALAPPDATA%\NOCT\dsdoc-bridge.log
  echo.
  choice /c YN /n /m "Stop starting it at login? [Y/N] "
  if errorlevel 2 (
    echo Left as it is.
    echo.
    pause
    exit /b 0
  )
  schtasks /delete /tn "%TASK%" /f >nul 2>&1
  rem  Stop the copy that's running now, too.
  set "HOLDER="
  for /f "tokens=5" %%p in ('netstat -ano -p tcp ^| findstr /r /c:":%PORT% .*LISTENING"') do (
    if not defined HOLDER set "HOLDER=%%p"
  )
  if defined HOLDER taskkill /pid !HOLDER! /f >nul 2>&1
  echo.
  echo Done. The bridge no longer starts at login, and is not running now.
  echo Start it by hand any time with "Start Claude bridge.cmd".
  echo.
  pause
  exit /b 0
)

rem  --- Install ---------------------------------------------------------------
echo This will start the Claude bridge automatically every time you log in.
echo.
echo   bridge: %~dp0
echo   node:   %NODE%
echo   log:    %LOCALAPPDATA%\NOCT\dsdoc-bridge.log
echo.
choice /c YN /n /m "Set that up? [Y/N] "
if errorlevel 2 (
  echo Nothing changed.
  echo.
  pause
  exit /b 0
)
echo.

if not exist "node_modules" (
  echo Installing dependencies first...
  call npm install
  if errorlevel 1 (
    echo.
    echo Install failed - not setting up the login item.
    echo.
    pause
    exit /b 1
  )
  echo.
)

rem  Bake the exact node path so the hidden login start doesn't depend on the
rem  PATH a logon session happens to have.
> ".node-path" echo %NODE%

rem  A bridge already running by hand would hold the port and the task would come
rem  up bound to nothing. Stop it first - the task replaces it.
set "HOLDER="
for /f "tokens=5" %%p in ('netstat -ano -p tcp ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  if not defined HOLDER set "HOLDER=%%p"
)
if defined HOLDER (
  echo Stopping the bridge that's already running, so the login item can take over.
  taskkill /pid !HOLDER! /f >nul 2>&1
  timeout /t 1 /nobreak >nul
)

rem  Register a per-user task that runs at logon, hidden (via the .vbs, which
rem  starts node with no console window).
schtasks /create /tn "%TASK%" /sc onlogon /rl limited /f /tr "wscript.exe \"%~dp0run-hidden.vbs\"" >nul 2>&1
if errorlevel 1 (
  echo Couldn't register the login item - Windows refused to create the task.
  echo You can still start the bridge by hand with "Start Claude bridge.cmd".
  echo.
  pause
  exit /b 1
)

rem  Start it now, so there's no need to log out and back in.
wscript.exe "%~dp0run-hidden.vbs"
timeout /t 2 /nobreak >nul

set "UP="
for /f "tokens=5" %%p in ('netstat -ano -p tcp ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  if not defined UP set "UP=%%p"
)
if defined UP (
  echo Done - the bridge is running now and will start with every login.
  echo The plugin should show "Claude bridge connected" within a few seconds.
) else (
  echo Registered to start at login, but nothing is listening on port %PORT% yet.
  echo Check the log for why: %LOCALAPPDATA%\NOCT\dsdoc-bridge.log
)
echo.
echo To undo this, double-click this same file again.
echo.
pause
exit /b 0
