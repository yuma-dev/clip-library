; ClipLib NSIS customizations (referenced from package.json build.nsis.include).

; The bundled clipdip recorder runs detached from the app (tray-resident,
; possibly login-autostarted). The installer replaces resources\clipdip\
; clipdip.exe, so a running instance must be stopped or NSIS hits a locked
; file. The app's own silent-update path already stops it gracefully; this
; covers manual installer runs and login-autostarted clippers.
!macro customInit
  nsExec::Exec 'taskkill /F /IM clipdip.exe'
  nsExec::Exec 'taskkill /F /IM "ClipLib App.exe"'
!macroend

; ClipLib.exe at the install root is the native splash launcher (it starts
; "ClipLib App.exe", the Electron binary, and fades out once its window is on
; screen). electron-builder creates the shortcuts for the Electron binary;
; point them at the launcher instead so every click gets the instant splash.
; Taskbar pins from older installs already target ClipLib.exe and need no
; change.
!macro customInstall
  IfFileExists "$DESKTOP\ClipLib.lnk" 0 +2
    CreateShortCut "$DESKTOP\ClipLib.lnk" "$INSTDIR\ClipLib.exe" "" "$INSTDIR\ClipLib.exe" 0
  IfFileExists "$SMPROGRAMS\ClipLib.lnk" 0 +2
    CreateShortCut "$SMPROGRAMS\ClipLib.lnk" "$INSTDIR\ClipLib.exe" "" "$INSTDIR\ClipLib.exe" 0
!macroend
