@echo off
setlocal
echo =======================================================
echo Building ClearMD (MinGW-w64 / g++ - 100%% Standalone C++)
echo =======================================================

where g++ >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: g++ not found in PATH.
    exit /b 1
)

rem The exe is named for the version it contains, read from resource.h so a bump needs no edit here.
set "APPVER="
for /f "tokens=3" %%v in ('findstr /b /c:"#define VER_FILE_VERSION_STR" resource.h') do set "APPVER=%%~v"
if not defined APPVER (
    echo Error: VER_FILE_VERSION_STR not found in resource.h.
    exit /b 1
)

windres ClearMD.rc -O coff -o ClearMD.res.o
if %errorlevel% neq 0 (
    echo Resource compilation failed.
    exit /b %errorlevel%
)

g++ -Wall -Wextra -std=c++17 -O2 -s -municode -mwindows -static -static-libgcc -static-libstdc++ ^
    ClearMD.cpp ClearMD.res.o ^
    -lcomctl32 -lole32 -lshell32 -loleaut32 -lgdi32 -luser32 -luuid ^
    -o ClearMD_v%APPVER%.exe

if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] Built ClearMD_v%APPVER%.exe cleanly with -Wall -Wextra.
    echo Attach it to the release under the unversioned name ClearMD.exe.
) else (
    echo.
    echo [ERROR] Build failed.
)
endlocal
