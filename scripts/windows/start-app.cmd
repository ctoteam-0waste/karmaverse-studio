@echo off
rem Runs KarmaVerse Studio (production build) on port 3000 and restarts it if it stops.
rem Full paths: a hidden window started at sign-in may not have npm on its PATH.
rem Uses ping for waits: "timeout" fails without a console and caused a tight restart loop once.
cd /d "%~dp0..\.."
set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" set "NODE=node"
set "PATH=%ProgramFiles%\nodejs;%PATH%"
set "NODE_ENV=production"
if not exist data\logs mkdir data\logs
:loop
echo [%date% %time%] Starting KarmaVerse Studio >> data\logs\app.log
"%NODE%" node_modules\next\dist\bin\next start -H 0.0.0.0 -p 3000 >> data\logs\app.log 2>&1
echo [%date% %time%] KarmaVerse Studio stopped; restarting in 15 seconds >> data\logs\app.log
ping -n 16 127.0.0.1 > nul
goto loop
