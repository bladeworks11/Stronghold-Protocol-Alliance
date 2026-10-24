; 安装包的自定义部分（electron-builder 的 nsis.include）
;
; 为什么要在快捷方式上带 --no-sandbox：有些机器（杀软 / 组策略）会拦掉 Chromium 的渲染沙箱，
; 那样双击 exe 会一闪就退。实测本机（Kaspersky）就是如此。带参数启动不会影响正常机器。

!macro customInstall
  ; 卸载时把这两个快捷方式删掉（见 customUnInstall）
  Delete "$DESKTOP\卫戍协议：盟约.lnk"
  CreateShortCut "$DESKTOP\卫戍协议：盟约.lnk" "$INSTDIR\Stronghold Protocol.exe" "--no-sandbox" "$INSTDIR\icon.ico" 0

  CreateDirectory "$SMPROGRAMS\卫戍协议：盟约"
  CreateShortCut "$SMPROGRAMS\卫戍协议：盟约\卫戍协议：盟约.lnk" "$INSTDIR\Stronghold Protocol.exe" "--no-sandbox" "$INSTDIR\icon.ico" 0
  CreateShortCut "$SMPROGRAMS\卫戍协议：盟约\卸载 卫戍协议：盟约.lnk" "$INSTDIR\Uninstall 卫戍协议：盟约.exe"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\卫戍协议：盟约.lnk"
  Delete "$SMPROGRAMS\卫戍协议：盟约\卫戍协议：盟约.lnk"
  Delete "$SMPROGRAMS\卫戍协议：盟约\卸载 卫戍协议：盟约.lnk"
  RMDir "$SMPROGRAMS\卫戍协议：盟约"
!macroend
