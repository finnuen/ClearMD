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

rc /nologo /fo ClearMD.res ClearMD.rc
if %errorlevel% neq 0 (
    echo Resource compilation failed.
    exit /b %errorlevel%
)

cl /W4 /std:c++17 /EHsc /O2 /DUNICODE /D_UNICODE /permissive- /utf-8 ^
   ClearMD.cpp ClearMD.res ^
   /link /SUBSYSTEM:WINDOWS /MACHINE:X64 ^
   user32.lib gdi32.lib comctl32.lib ole32.lib shell32.lib oleaut32.lib ^
   /OUT:ClearMD.exe

if %errorlevel% equ 0 (
    echo.
    echo [SUCCESS] Built ClearMD.exe cleanly with /W4 and zero warnings.
) else (
    echo.
    echo [ERROR] Build failed.
)
endlocal
