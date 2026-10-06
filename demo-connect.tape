# vir connect demo: recurring lesson → reviewed rule → CLAUDE.md
# Regenerate with: vhs demo-connect.tape
#
# Recorded against a SANDBOX copy of the author's real ~/.vir and vault
# (/tmp/virdemo; layout in CONTRIBUTING.md). Every frame is real
# command output. The review scene shows the rule the real 2026-10-06
# `vir connect` run proposed; the dry run shows that same candidate before it
# existed. No paid call is made while recording.
Output assets/demo-connect.gif

Set Shell "bash"
Set FontSize 14
Set Width 1100
Set Height 820
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms
Env HOME "/tmp/virdemo/home"

Hide
Type "export PS1='$ ' && cp /tmp/virdemo/db-none.db ~/.vir/vir.db && clear"
Enter
Sleep 1s
Show

Type "# lessons you keep re-learning, across sessions"
Sleep 400ms
Enter
Type "vir connect --dry-run"
Sleep 400ms
Enter
Sleep 7s

Hide
Type "cp /tmp/virdemo/db-proposed.db ~/.vir/vir.db && cp /tmp/virdemo/rules-aside/*.md ~/Vir/vir/insights/rules/ && clear"
Enter
Sleep 1s
Show

Type "# the rule vir connect proposed, with its sources"
Sleep 400ms
Enter
Type "vir review --insights"
Sleep 400ms
Enter
Sleep 5s
Enter
Sleep 3s

Type "clear"
Enter
Sleep 500ms
Type "# CLAUDE.md gets it only with a yes, per rule"
Sleep 400ms
Enter
Type "vir sync-claude pripremi-rs"
Sleep 400ms
Enter
Sleep 4s
Type "y"
Sleep 300ms
Enter
Sleep 3s
Type "y"
Sleep 300ms
Enter
Sleep 4s
