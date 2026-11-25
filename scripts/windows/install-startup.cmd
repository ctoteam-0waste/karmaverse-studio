@echo off
rem Makes KarmaVerse Studio start by itself when this Windows user signs in.
rem Run again after moving the project folder. To undo, delete the shortcut it prints.
set "TARGET=%~dp0start-hidden.vbs"
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\KarmaVerse Studio.vbs"
> "%LINK%" echo CreateObject("WScript.Shell").Run "wscript.exe ""%TARGET%""", 0, False
echo Installed: %LINK%
