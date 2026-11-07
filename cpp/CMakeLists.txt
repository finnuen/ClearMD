cmake_minimum_required(VERSION 3.16)
project(ClearMD VERSION 1.0.0.6 LANGUAGES CXX RC)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
    add_compile_options(/W4 /permissive- /utf-8 /DUNICODE /D_UNICODE)
else()
    add_compile_options(-Wall -Wextra -DUNICODE -D_UNICODE)
endif()

add_executable(ClearMD WIN32
    ClearMD.cpp
    ClearMD.rc
    resource.h
    ClearMD.ico
)
# manifest.xml is embedded via ClearMD.rc; do NOT also list it as a source (duplicate-manifest link error on MSVC)

if(NOT MSVC)
    target_link_options(ClearMD PRIVATE -municode -static -static-libgcc -static-libstdc++)
endif()

target_link_libraries(ClearMD PRIVATE
    user32
    gdi32
    comctl32
    ole32
    shell32
    oleaut32
    uuid
)
