' Starts the Claude bridge with no visible window.
'
' The login task created by "Run bridge at login.cmd" runs this, so the bridge
' comes up silently at every login. To watch it instead - first run, or when
' something looks wrong - double-click "Start Claude bridge.cmd" and read the
' window. This writes the same output to a log either way.

Option Explicit

Dim sh, fso, here, nodeCmd, pathFile, ts, p, logDir, logFile, cmd

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)

' Prefer the exact node the toggle discovered; fall back to whatever is on PATH.
' A logon session's PATH is not always the one a terminal has, so the baked
' path is what keeps this working rather than only working sometimes.
nodeCmd = "node"
pathFile = fso.BuildPath(here, ".node-path")
If fso.FileExists(pathFile) Then
  Set ts = fso.OpenTextFile(pathFile, 1)
  If Not ts.AtEndOfStream Then p = Trim(ts.ReadLine)
  ts.Close
  If Len(p) > 0 Then nodeCmd = """" & p & """"
End If

' Log somewhere local and quiet, never the Drive folder - a log that syncs
' would churn the whole team's Drive every few seconds.
logDir = fso.BuildPath(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%"), "NOCT")
If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
logFile = fso.BuildPath(logDir, "dsdoc-bridge.log")

cmd = "cmd /c cd /d """ & here & """ && " & nodeCmd & " server.mjs >> """ & logFile & """ 2>&1"

' 0 = hidden window, False = don't wait for it to finish.
sh.Run cmd, 0, False
