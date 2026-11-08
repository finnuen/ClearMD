@echo off
setlocal
echo =======================================================
echo Building ClearMD (MSVC / cl.exe - 100%% Standalone C++)
echo =======================================================

where cl >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: cl.exe not found in PATH.
    echo Please open the "x64 Native Tools Command Prompt for VS 2022 / 2019" and re-run.
    exit /b 1
)

rem The exe is named for the version it contains, read from resource.h so a bump needs no edit here.
set "APPVER="
for /f "tokens=3" %%v in ('findstr /b /c:"#define VER_FILE_VERSION_STR" resource.h') do set "APPVER=%%~v"
if not defined APPVER (
    echo Error: VER_FILE_VERSION_STR not found in resource.h.
    exit /b 1
)

rc /nologo /fo ClearMD.res ClearMD.rc
if %errorlevel% neq 0 (
    echo Resource compilation failed.
    exit /b %errorlevel%
)

cl /W4 /std:c++17 /EHsc /O2 /DUNICODE /D_UNICODE /permissive- /utf-8 ^
   ClearMD.cpp ClearMD.res ^
   /link /SUBSYSTEM:WINDOWS /MACHINE:X64 ^
   user32.lib gdi32.lib comctl32.lib ole32.lib shell32.lib oleaut32.lib ^
   /OUT:ClearMD_v%APPVER%.exe

if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] Built ClearMD_v%APPVER%.exe cleanly with /W4 and zero warnings.
    echo Attach it to the release under the unversioned name ClearMD.exe.
) else (
    echo.
    echo [ERROR] Build failed.
)
endlocal
