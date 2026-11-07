# History and favorites

Moontide keeps every version of your music, so you can go back to any earlier one. This page says what
is kept, how to bring a version back, where the file lives and what its limits are.

## What is kept

Every version that plays is kept. That means Claude's own changes and your edits played with
Ctrl+Enter, each with its time, who made it and a short label. A move you make in the page, such as a
Mixer move or a section launch, is kept too, as a version made by the page.

Failed code and stops are not versions. If a change fails, the music keeps playing and nothing is
added.

## The History view

Press 1 to open the History view. It shows one row for each version, newest first, as a list or as a
tree. A row shows what changed in that version. Choose Changes on a row to see the lines that changed.
Older versions load when you ask for them.

A click on a row, or Enter on the selected one, brings that version back with Restore. The page does
not rewrite the past: a restore is a new version that records which version it came from. The tree
shows these links.

## Ask Claude

You can also bring versions back in words:

- "Go back to the previous version."
- "The one from 3 changes ago."
- "The one with the bass."
- "Keep this one, call it Take two."
- "List my favorites."

A favorite is a version with a name. Claude keeps it with `favorite_version`, lists the history with
`list_history` and brings a version back with `restore_version`. The Session drawer shows the number of
the version that plays, in its Last change card, for example v42.

## Where the file is

The history lives in one text file with one entry on each line. It survives the end of the Claude
session. The folder depends on your system:

- macOS: `~/Library/Application Support/moontide/history.jsonl`
- Linux: `$XDG_DATA_HOME/moontide/history.jsonl`, or `~/.local/share/moontide/history.jsonl`
- Windows: `%APPDATA%\moontide\history.jsonl`

Set `MOONTIDE_DATA_DIR` to use another folder. Your instruments file and your sound catalogs live in
the same data folder. Delete the folder if you want everything gone.

## The limits

- **The cap.** The history keeps the last 1000 versions. Older ones are dropped in batches, and Claude
  is told when it happens. Favorites are never dropped.
- **A line that cannot be read.** Claude is told which lines. They stay in the file untouched, and all
  the other versions work.
- **A file that cannot be read or written.** The music keeps working, and Claude is told.
- **One Moontide at a time.** Run one Moontide at a time with the same history file. Two at once can
  give two versions the same number.

If something goes wrong with a history line or with the file, see the Troubleshooting page.

## What was verified

**Verified:**

- What is kept, restore, favorites, the cap and the unreadable lines are covered by automated tests,
  including a real server and a real file, and a drive of the real page in headless Chrome checks the
  History view.
- That the history survives a restart of the server is covered by an automated test.
- The folder for each system is covered by a test that stands in for the system.

**Not verified:**

- By hand on Windows and on Linux: that the history file appears in its folder after the first change.
- By hand on any system: that asking for the history after quitting and restarting Claude lists the
  earlier versions.
- How the History view reads on a large screen.
- Two Moontide servers on one history file. The advice is to avoid it.
