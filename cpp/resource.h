#pragma once

#define IDC_MAIN_LISTVIEW       1001
#define IDC_BTN_ADD_FOLDER      1002
#define IDC_BTN_ADD_FILE        1003
#define IDC_BTN_CLEAR_LIST      1004
#define IDC_BTN_CLEAR_METADATA  1005
#define IDC_STATUSBAR           1006
#define IDC_PROGRESSBAR         1007

#define IDI_APP_ICON            2001

#define IDC_CONFIRM_PROCEED     4001
#define IDC_CONFIRM_CANCEL      4002
#define IDC_CONFIRM_PROGRESS    4003

// Title bar text (shows the app version). tools/bump_version.py keeps it in step with the file version.
#define APP_TITLE               L"ClearMD v1.0"

#define IDM_REMOVE_SELECTED     3001
#define IDM_SELECT_ALL          3002

// Versioning: two numbers, major.minor, bumped per build (tools/bump_version.py).
// Windows VERSIONINFO still takes four numeric fields, so BUILD and REVISION stay 0.
#define VER_FILE_VERSION_MAJOR      1
#define VER_FILE_VERSION_MINOR      0
#define VER_FILE_VERSION_BUILD      0
#define VER_FILE_VERSION_REVISION   0

#define VER_FILE_VERSION            1,0,0,0
#define VER_FILE_VERSION_STR        "1.0"

#define VER_PRODUCT_VERSION_MAJOR    1
#define VER_PRODUCT_VERSION_MINOR    0
#define VER_PRODUCT_VERSION_BUILD    0
#define VER_PRODUCT_VERSION_REVISION 0

#define VER_PRODUCT_VERSION         1,0,0,0
#define VER_PRODUCT_VERSION_STR     "1.0"

#define VER_COMPANYNAME_STR         "ClearMD Open Source"
#define VER_FILEDESCRIPTION_STR     "ClearMD - Lossless Metadata Stripper"
#define VER_INTERNALNAME_STR        "ClearMD"
#define VER_LEGALCOPYRIGHT_STR      "Copyright (C) 2026 ClearMD Contributors"
#define VER_ORIGINALFILENAME_STR    "ClearMD.exe"
#define VER_PRODUCTNAME_STR         "ClearMD"
