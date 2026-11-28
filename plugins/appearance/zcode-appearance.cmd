@echo off
rem Start ZCode through the appearance launcher without keeping a console window open.
rem Make a shortcut to this file (right-click, Send to, Desktop) and start ZCode from there.
rem If the launcher cannot start ZCode it shows a message box instead of writing to a console.
rem The script's path travels in an environment variable, and PowerShell puts it in quotes:
rem spliced into the command line, a folder with & or ' in its name would not start at all.
rem The launcher runs from the user's own folder: ZCode inherits it, and what the app writes
rem "next to itself" (the shell behind a file dialog did) lands there, not in the plugin's. With no
rem profile folder in the environment (a service, a stripped shell) PowerShell falls back to the
rem user folder it resolves by itself.
set ZCODE_APPEARANCE_NO_CONSOLE=1
set "ZCODE_APPEARANCE_SCRIPT=%~dp0bin\launch.mjs"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node' -ArgumentList ([char]34 + $env:ZCODE_APPEARANCE_SCRIPT + [char]34) -WorkingDirectory $(if ($env:USERPROFILE) { $env:USERPROFILE } else { $pwd }) -WindowStyle Hidden"
