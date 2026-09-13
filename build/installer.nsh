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
  IfFileExists "$DESKTOP\ClipLib.lnk" 0 +2
    CreateShortCut "$DESKTOP\ClipLib.lnk" "$INSTDIR\ClipLib Launcher.exe" "" "$INSTDIR\ClipLib Launcher.exe" 0
  IfFileExists "$SMPROGRAMS\ClipLib.lnk" 0 +2
    CreateShortCut "$SMPROGRAMS\ClipLib.lnk" "$INSTDIR\ClipLib Launcher.exe" "" "$INSTDIR\ClipLib Launcher.exe" 0
!macroend
