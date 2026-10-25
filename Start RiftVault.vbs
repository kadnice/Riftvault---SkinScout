' Start RiftVault.vbs
' Double-click this to start RiftVault with no terminal window, like a normal
' app. It runs quietly in the system tray (near the clock).
' Messages that used to appear in the terminal are saved to riftvault.log in
' this folder instead, in case something needs troubleshooting.

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Run from the folder this file is in (the RiftVault project folder)
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)

' 0 = hidden window, False = don't wait for it to finish
shell.Run "cmd /c npm start > riftvault.log 2>&1", 0, False
