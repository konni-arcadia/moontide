# First music

This page walks you through your first minute with Moontide: how the music starts, what you see, and
how to ask for changes. It comes after the [Install](install.md) page. If Moontide is not added to
Claude yet, start there.

## Start the music

A new Claude session starts nothing. Moontide waits until you want it, so it does not open a tab in
every session you begin. You start it in one of three ways:

- Ask for music, for example "Play something calm to start the day" or "Give me a slow, warm groove".
- Say "start Moontide".
- In Claude Code, type `/mcp__moontide__start`.

Then three things happen:

1. Claude writes the code and Moontide opens the page in a new tab.
2. The page is at http://localhost:5757, or on another port when 5757 is busy. Claude's reply names the
   address, so you can open it yourself if the tab does not appear.
3. Claude says in one line what it chose.

The first minute looks like this:

```
 you:     "Play something calm to start the day"
 Claude:  writes the code, starts Moontide, names the address
 page:    opens in a new tab and shows the code
 you:     click once anywhere in the page      <- sound starts
 you:     "darker"   "add a bass"   "slower"
 page:    each change takes over, the music never stops
```

## Click once for sound

Browsers start sound only after you click in the page. Click anywhere in it once. After that,
changes from Claude play without another click. If you hear nothing, see
[Troubleshooting](troubleshooting.md).

## Ask for changes

Talk to Claude as you would to a band member. Short requests work well: "darker", "add a bass",
"slower". Each change takes over within a fraction of a second, without stopping the music. The
[Asking Claude](asking-claude.md) page says more about what to ask and what Claude knows.

## Stop and Play

Claude can stop the music when you ask. The page has its own Stop button in the top bar too. While
the music plays the button reads Stop, and when it is stopped the button reads Play. Play runs the
code that is in the editor.

## Open no tab

If you do not want a tab to open by itself, set `MOONTIDE_NO_BROWSER=1` in the environment before
you start Moontide. Nothing opens then: open the address from Claude's reply yourself.

## Several Claude sessions, several tabs

Each Claude session that started Moontide has its own page and its own port. The title of the tab
names the folder that session runs in and the port, for example "Moontide · my-project · 5757". If
you have several tabs, ask Claude which one is its own: it answers with the address, the port and the
tab title. The Session drawer in the top bar shows the same name.

## Where to go next

- [The page and its views](the-page.md) shows what is on the screen.
- [Asking Claude](asking-claude.md) tells you how to ask and what Claude can look up.

## What was verified

**Verified:**

- Starting from a Claude session, the page opening, the click for sound and asking for changes were
  used by hand on macOS with Chrome, in Claude Code and in Claude Desktop.
- The start on demand, the address in Claude's reply and the tab title with the folder and the port
  are covered by automated tests.

**Not verified:**

- Windows and Linux were not used by hand.
- Edge, Safari and Firefox were not tried with the page.
- Whether a reader who has never used Moontide finds the first minute without help.
