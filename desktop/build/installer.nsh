; Pantalla de bienvenida con la imagen del juego (installerSidebar.bmp)
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Te damos la bienvenida a Pixel Shooter"
  !define MUI_WELCOMEPAGE_TEXT "Este asistente va a instalar Pixel Shooter en tu PC.$\r$\n$\r$\nMazmorras roguelike, duelos PvP con ranking y partidas cooperativas online o por red local con tus amigos (también desde el celular).$\r$\n$\r$\nHacé clic en Siguiente para continuar."
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Regla del Firewall de Windows para las partidas por red local (TCP 47820 / UDP 47821),
; así nadie tiene que tocar la configuración para que sus amigos se unan.
; Solo se agrega si el instalador corre como administrador (instalación para todos los usuarios);
; si no, Windows pregunta la primera vez que se crea una partida local.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Pixel Shooter"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Pixel Shooter" dir=in action=allow program="$INSTDIR\PixelShooter.exe" enable=yes profile=private,domain'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Pixel Shooter"'
!macroend
