@echo off
rem Start ZCode through the appearance launcher without keeping a console window open.
rem Make a shortcut to this file (right-click, Send to, Desktop) and start ZCode from there.
rem If the launcher cannot start ZCode it shows a message box instead of writing to a console.
set ZCODE_APPEARANCE_NO_CONSOLE=1
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node' -ArgumentList '\"%~dp0.\bin\launch.mjs\"' -WindowStyle Hidden"
