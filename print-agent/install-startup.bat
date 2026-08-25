@echo off
REM ---------------------------------------------------------------------
REM  Installs the print agent so it starts with Windows.
REM
REM  Run this ONCE on the reception PC, by double-clicking it. After that
REM  the agent starts whenever the PC does, and staff never type a command.
REM
REM  To undo: delete the shortcut this creates from the folder that opens
REM  with Win+R -> shell:startup
REM ---------------------------------------------------------------------

setlocal

set "REPO=%~dp0.."
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LAUNCHER=%~dp0run-agent.vbs"

echo.
echo   Installing the print agent to start with Windows
echo   Repo: %REPO%
echo.

if not exist "%REPO%\print-agent\agent.mjs" (
  echo   ERROR: agent.mjs not found next to this script.
  echo   Keep install-startup.bat inside the print-agent folder.
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo   ERROR: Node.js is not installed on this PC.
  echo   Install it from https://nodejs.org then run this again.
  echo.
  pause
  exit /b 1
)

REM A .vbs launcher rather than the .bat itself: it starts the agent with no
REM console window at all. A minimised window still shows in the taskbar and
REM invites someone to close it, which silently stops printing.
> "%LAUNCHER%" echo Set sh = CreateObject("WScript.Shell")
>> "%LAUNCHER%" echo sh.CurrentDirectory = "%REPO%"
>> "%LAUNCHER%" echo sh.Run "cmd /c npm run print-agent", 0, False

copy /y "%LAUNCHER%" "%STARTUP%\TokenGenerator print agent.vbs" >nul
if errorlevel 1 (
  echo   ERROR: could not write to the Startup folder.
  echo.
  pause
  exit /b 1
)

echo   Done. The agent will start with Windows.
echo.
echo   Starting it now so you do not have to reboot...
start "" wscript "%STARTUP%\TokenGenerator print agent.vbs"

echo.
echo   It runs in the background with no window. To check it is working,
echo   issue a token and see whether a slip prints.
echo.
pause
