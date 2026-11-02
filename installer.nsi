!include "MUI2.nsh"
RequestExecutionLevel admin

; Ícones do instalador (caminho absoluto)
!define MUI_ICON "C:\\Users\\eojap\\Projetos\\Outros\\Assitente do Zap\\build\\icon.ico"
!define MUI_UNICON "C:\\Users\\eojap\\Projetos\\Outros\\Assitente do Zap\\build\\icon.ico"

Name "Link no WhatsApp"
OutFile "dist\\Link-no-WhatsApp-Setup-1.0.0.exe"
InstallDir "$PROGRAMFILES\\LinkNoWhatsApp"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "PortugueseBR"
!insertmacro MUI_LANGUAGE "English"

Section "MainSection" SEC01
  SetOutPath "$INSTDIR"
  SetShellVarContext all
  File /r "${__FILEDIR__}\\dist\\win-unpacked\\*.*"
  File "${__FILEDIR__}\\build\\icon.ico"
  CreateDirectory "$SMPROGRAMS\\LinkNoWhatsApp"
  CreateShortCut "$SMPROGRAMS\\LinkNoWhatsApp\\Link no WhatsApp.lnk" "$INSTDIR\\Link no WhatsApp.exe" "" "$INSTDIR\\icon.ico" 0
  ; Desktop shortcut (always)
  CreateShortCut "$DESKTOP\\Link no WhatsApp.lnk" "$INSTDIR\\Link no WhatsApp.exe" "" "$INSTDIR\\icon.ico" 0

  ; Register in "Apps & features"
  SetRegView 32
  SetRegView 64
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LinkNoWhatsApp" "DisplayName" "Link no WhatsApp"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LinkNoWhatsApp" "DisplayVersion" "1.0.0"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LinkNoWhatsApp" "Publisher" "Seu Nome ou Empresa"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LinkNoWhatsApp" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LinkNoWhatsApp" "UninstallString" "$INSTDIR\\uninstall.exe"
  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LinkNoWhatsApp" "DisplayIcon" "$INSTDIR\\icon.ico"
  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LinkNoWhatsApp" "NoModify" 1
  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\LinkNoWhatsApp" "NoRepair" 1

  Exec "$INSTDIR\\Link no WhatsApp.exe"

  ; Generate uninstaller
  WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\\Link no WhatsApp.exe"
  RMDir /r "$INSTDIR"
  Delete "$SMPROGRAMS\\LinkNoWhatsApp\\Link no WhatsApp.lnk"
  RMDir "$SMPROGRAMS\\LinkNoWhatsApp"
  Delete "$DESKTOP\\Link no WhatsApp.lnk"
SectionEnd
