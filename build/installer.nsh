; ClipLib NSIS customizations (referenced from package.json build.nsis.include).

; The bundled clipdip recorder runs detached from the app (tray-resident,
; possibly login-autostarted). The installer replaces resources\clipdip\
; clipdip.exe, so a running instance must be stopped or NSIS hits a locked
; file. The app's own silent-update path already stops it gracefully; this
; covers manual installer runs and login-autostarted clippers.
!macro customInit
  nsExec::Exec 'taskkill /F /IM clipdip.exe'
!macroend

; "ClipLib Launcher.exe" at the install root is the native splash launcher
; (it starts ClipLib.exe, the Electron binary, and fades out once its window
; is on screen). electron-builder creates the shortcuts for ClipLib.exe;
; point them at the launcher so every click gets the instant splash. The
; Electron binary keeps its name on purpose: the installer only preserves
; shortcuts and taskbar pins across an update when the app executable it
; expects already exists in the old install. Taskbar pins are retargeted by
; the app itself on launch (repairTaskbarPins in main.js).
!macro customInstall
  ; A recreated .lnk loses the AppUserModelID electron-builder stamped on it;
  ; without it a pin made from the shortcut does not group with the running
  ; window (two taskbar buttons). Stamp it again after each CreateShortCut.
  IfFileExists "$DESKTOP\ClipLib.lnk" 0 +3
    CreateShortCut "$DESKTOP\ClipLib.lnk" "$INSTDIR\ClipLib Launcher.exe" "" "$INSTDIR\ClipLib Launcher.exe" 0
    WinShell::SetLnkAUMI "$DESKTOP\ClipLib.lnk" "${APP_ID}"
  IfFileExists "$SMPROGRAMS\ClipLib.lnk" 0 +3
    CreateShortCut "$SMPROGRAMS\ClipLib.lnk" "$INSTDIR\ClipLib Launcher.exe" "" "$INSTDIR\ClipLib Launcher.exe" 0
    WinShell::SetLnkAUMI "$SMPROGRAMS\ClipLib.lnk" "${APP_ID}"
!macroend
