' Starts start-app.cmd with no visible window (used by the Startup-folder shortcut).
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "cmd.exe /c """ & dir & "\start-app.cmd""", 0, False
