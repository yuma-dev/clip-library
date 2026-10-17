; Setsu NSIS customizations (referenced from package.json build.nsis.include).

; The bundled recorder runs detached from the app (tray-resident, possibly
; login-autostarted) and the launcher lives through the splash. The installer
; replaces both, so running ones must be stopped or the old uninstaller hits a
; locked file, aborts, and the update never lands. Old and new names: an install
; from before the Setsu rename still runs clipdip.exe / ClipLib Launcher.exe,
; and electron-builder's own running-app check only knows the new exe name.
!macro killHelpers
  nsExec::Exec 'taskkill /F /IM clipdip.exe'
  nsExec::Exec 'taskkill /F /IM "Setsu Recorder.exe"'
  nsExec::Exec 'taskkill /F /IM "ClipLib Launcher.exe"'
  nsExec::Exec 'taskkill /F /IM "Setsu Launcher.exe"'
!macroend

!macro customInit
  !insertmacro killHelpers
!macroend

; runs in this version's uninstaller, which a later installer (or a manual
; downgrade) calls with --updated
!macro customUnInit
  !insertmacro killHelpers
!macroend

!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"

; "Setsu Launcher.exe" at the install root is the native splash launcher (it
; starts Setsu.exe, the Electron binary, and fades out once its window is on
; screen). electron-builder creates the shortcuts for Setsu.exe; point them at
; the launcher so every click gets the instant splash. Taskbar pins are
; retargeted by the app itself on launch (repairTaskbarPins in main.js).
!macro customInstall
  ; A recreated .lnk loses the AppUserModelID electron-builder stamped on it;
  ; without it a pin made from the shortcut does not group with the running
  ; window (two taskbar buttons). Stamp it again after each CreateShortCut.
  ${If} ${FileExists} "$DESKTOP\Setsu.lnk"
    CreateShortCut "$DESKTOP\Setsu.lnk" "$INSTDIR\Setsu Launcher.exe" "" "$INSTDIR\Setsu Launcher.exe" 0
    WinShell::SetLnkAUMI "$DESKTOP\Setsu.lnk" "${APP_ID}"
  ${EndIf}
  ${If} ${FileExists} "$SMPROGRAMS\Setsu.lnk"
    CreateShortCut "$SMPROGRAMS\Setsu.lnk" "$INSTDIR\Setsu Launcher.exe" "" "$INSTDIR\Setsu Launcher.exe" 0
    WinShell::SetLnkAUMI "$SMPROGRAMS\Setsu.lnk" "${APP_ID}"
  ${EndIf}
  ; pre-rename shortcuts point at a launcher that is gone now. plain Delete,
  ; WinShell::UninstShortcut would also unpin
  Delete "$DESKTOP\ClipLib.lnk"
  Delete "$SMPROGRAMS\ClipLib.lnk"

  ; recorder autostart points at the exe path, which the rename just deleted.
  ; only rewrite a value that exists: no value means the user turned it off.
  ; the name stays ClipLib, Task Manager's startup toggle is keyed on it
  ReadRegStr $0 HKCU "${RUN_KEY}" "ClipLib"
  ReadRegStr $1 HKCU "${RUN_KEY}" "ClipDip"
  ${If} $0 != ""
  ${OrIf} $1 != ""
    WriteRegStr HKCU "${RUN_KEY}" "ClipLib" '"$INSTDIR\resources\clipdip\Setsu Recorder.exe"'
    DeleteRegValue HKCU "${RUN_KEY}" "ClipDip"
  ${EndIf}
!macroend

; a real uninstall (not the one an update runs) takes the recorder autostart
; along, or Windows keeps launching a deleted exe at login
!macro customUnInstall
  ${IfNot} ${isUpdated}
    DeleteRegValue HKCU "${RUN_KEY}" "ClipLib"
    DeleteRegValue HKCU "${RUN_KEY}" "ClipDip"
  ${EndIf}
!macroend
