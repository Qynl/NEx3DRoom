@echo off
rem ============================================================
rem  NEx3D Room - double-click to start the desktop application
rem  Needs Python 3.8+ from python.org ("Add to PATH" enabled).
rem  Nothing else is installed: standard library only.
rem ============================================================
setlocal
cd /d "%~dp0"

where pythonw >nul 2>nul
if %errorlevel%==0 (
    start "" pythonw "%~dp0run.pyw"
    goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
    start "" python "%~dp0run.py"
    goto :eof
)

where py >nul 2>nul
if %errorlevel%==0 (
    start "" py -3 "%~dp0run.py"
    goto :eof
)

echo.
echo  Python was not found on this PC.
echo  Install Python 3.8 or newer from https://www.python.org/downloads/
echo  and tick "Add python.exe to PATH" during setup.
echo.
pause
