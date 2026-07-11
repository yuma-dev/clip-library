; ClipLib NSIS customizations (referenced from package.json build.nsis.include).

; The bundled clipdip recorder runs detached from the app (tray-resident,
; possibly login-autostarted). The installer replaces resources\clipdip\
; clipdip.exe, so a running instance must be stopped or NSIS hits a locked
; file. The app's own silent-update path already stops it gracefully; this
; covers manual installer runs and login-autostarted clippers.
!macro customInit
  nsExec::Exec 'taskkill /F /IM clipdip.exe'
!macroend
