; 卫戍协议：盟约 · 桌面客户端安装包（NSIS 3，Unicode，按用户安装，无需管理员）
;
; 生成的快捷方式都带 --no-sandbox：有些机器（杀软/组策略）会拦掉 Chromium 的渲染沙箱，
; 双击 exe 会一闪就退；带这个参数不影响正常机器。
;
; 编译：makensis.exe /INPUTCHARSET UTF8 build\nsis\installer.nsi
; 负载：.nsis-staging\（electron-builder 打出的 win-unpacked + PLAY.bat/README.txt/BUILD.txt）

Unicode true
!include "MUI2.nsh"

!define APPNAME "卫戍协议：盟约"
!define APPEXE "Stronghold Protocol.exe"
!define APPVERSION "0.3.0"
!define PUBLISHER "Stronghold Protocol (fan project)"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\StrongholdProtocol"

; 负载与输出名可用 /D 覆盖（含素材版就是这么编的）：
;   makensis /INPUTCHARSET UTF8 /DPAYLOAD="..\..\.nsis-full\*.*" /DOUTNAME="...-full.exe" installer.nsi
!ifndef PAYLOAD
  !define PAYLOAD "..\..\.nsis-staging\*.*"
!endif
!ifndef OUTNAME
  !define OUTNAME "Stronghold-Protocol-Setup-${APPVERSION}.exe"
!endif
!ifndef ADDTITLE
  !define ADDTITLE ""
!endif

Name "${APPNAME}${ADDTITLE}"
OutFile "..\..\dist-installer\${OUTNAME}"
InstallDir "$LOCALAPPDATA\Programs\Stronghold Protocol"
InstallDirRegKey HKCU "Software\StrongholdProtocol" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 32
; 安装包自身的版本信息（右键「属性 → 详细信息」里能看到）
VIProductVersion "0.3.0.0"
VIAddVersionKey /LANG=2052 "ProductName" "卫戍协议：盟约"
VIAddVersionKey /LANG=2052 "FileDescription" "卫戍协议：盟约 · 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "0.3.0"
VIAddVersionKey /LANG=2052 "ProductVersion" "0.3.0"
VIAddVersionKey /LANG=2052 "CompanyName" "Stronghold Protocol (fan project)"
VIAddVersionKey /LANG=2052 "LegalCopyright" "GPL-3.0-or-later, game art (c) Hypergryph / Yostar"

ShowInstDetails show
ShowUninstDetails show

!define MUI_ICON "..\..\icon.ico"
!define MUI_UNICON "..\..\icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\PLAY.bat"
!define MUI_FINISHPAGE_RUN_TEXT "现在启动《卫戍协议：盟约》"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "安装" SEC_MAIN
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}"

  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; 快捷方式（带 --no-sandbox）
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "--no-sandbox" "$INSTDIR\icon.ico" 0
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortCut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "--no-sandbox" "$INSTDIR\icon.ico" 0
  CreateShortCut "$SMPROGRAMS\${APPNAME}\卸载 ${APPNAME}.lnk" "$INSTDIR\Uninstall.exe"

  ; 控制面板「应用和功能」里的条目
  WriteRegStr HKCU "Software\StrongholdProtocol" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${APPVERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${REGKEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\卸载 ${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"
  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegKey HKCU "Software\StrongholdProtocol"
  RMDir /r "$INSTDIR"
SectionEnd
