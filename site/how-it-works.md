# How it works

This page is for the curious reader. It shows the pieces of Moontide, how they talk to each other, what
each tool does, and why it is built this way. You do not need any of it to make music.

## Why Moontide exists

Moontide is a personal project, made out of curiosity: how far can an AI assistant go at making real
music, not a technical demo, when it is given a good instrument? Strudel is that instrument. It is a
live-coding language where a change lands on the next cycle with no cut, and where the music is plain
text that both Claude and you can read. So Claude writes the code, and the code stays on screen while it
plays.

Moontide does not start from scratch. The music engine is [Strudel](https://strudel.cc), the JavaScript
port of TidalCycles. Moontide is the bridge between Claude and a Strudel page.

## The pieces

```text
 you --talk--> Claude --MCP over stdio--> Moontide server --WebSocket on localhost--> browser page
                                              |                                      Strudel plays the
                                              +-- history file on your disk          code: sound and
                                                                                     Web MIDI out
```

- **You and Claude** talk in the chat, in your words.
- **Moontide** is an MCP server. Claude connects to it and calls its tools. It starts nothing until you
  ask for music or say "start Moontide".
- **The page** opens in your browser. It shows the code in an editor, plays it with Strudel, and sends
  MIDI to your instruments through Web MIDI. The server and the page talk over a WebSocket on your own
  computer, on localhost.
- **The history file** is on your disk, in the data folder. Every version that played is kept in it.

The server listens on 127.0.0.1 only. The page [Network, privacy, credits and license](privacy-and-credits.md), at the end
of this manual, says what leaves your computer.

## How a change travels

1. You ask. Claude writes Strudel code and sends it with a tool.
2. The server checks it, keeps it in the history, and sends it to the page.
3. The page evaluates it and the new code takes over on the next cycle, without a cut. If you asked for a
   change on a bar or phrase line, it waits for the line (see [Tempo ramps](tempo.md) and
   [Asking Claude](asking-claude.md)).
4. If the code cannot play, the previous music keeps playing, the page shows a banner, and Claude is told
   the real reason.

The other direction works too. A right-click in the page sends Claude a request with the context of what
you pointed at. Requests reach Claude through a small listener that Claude runs, which wakes it on each
request, or they wait and arrive with Claude's next action in Moontide (see
[Asking from the page](page-requests.md)).

## Why it is built this way

The numbers behind some of these choices are on [What was measured](what-was-measured.md).

- **Strudel is the only pattern language.** Code runs in the browser with no install, a change applies on
  the next cycle without stopping the clock, and it supports MIDI output natively.
- **An MCP server.** The tools and the Strudel reference ship in one package, and any MCP client can use
  them. A single line of setup is enough.
- **Facts, not taste.** Moontide gives Claude facts about its Strudel version and relies on Claude's own
  knowledge of music to read what you ask. It ships no mood words, no style material and no model pieces,
  so the music is not pulled toward one style.
- **The code is the center of the page.** The views are other angles on the same Strudel text. Controls
  edit the text, so the code stays the single source of truth.
- **The chat stays in its own window.** The page has only a small right-click box. Claude answers in its
  own window, by changing the music.
- **The page restores through the server.** A click on a version in the History view is the same restore
  that Claude's `restore_version` does, so nothing in the history is ever rewritten.
- **Versions record their parent.** Each version carries the version that was playing when it was made,
  so the History view can draw a tree.

## The tools

Claude has these tools. Each one is listed by its name.

- `get_code`: reads the code that plays now, including edits you evaluated by hand.
- `get_strudel_reference`: returns the reference for the pinned Strudel version, by topic: the facts about
  what exists and how to write it.
- `set_code`: replaces the music with new code. The new code takes over within a fraction of a second,
  without stopping the music, and it can wait for the next bar or phrase line.
- `edit_code`: changes part of the code by exact text replacement, so only the change is sent.
- `list_history`: lists the versions that played, newest first, and finds one by a word or by favorite.
- `favorite_version`: keeps a version as a named favorite that is never dropped from the history.
- `restore_version`: plays a past version again; the restore is added to the history as a new version.
- `answer_request`: closes a request typed in the page without changing the music, with one sentence the
  page shows under the request.
- `stop`: stops all sound at once, even when the current code is broken.
- `get_midi_instruments`: lists the instruments described in your setup file, with their ports, channels,
  sounds, controls and settings, as facts.
- `search_midi_sounds`: finds sounds by name or category in the catalog of an instrument.
- `save_midi_model`: saves an instrument model that Claude drafted from a page of a manual, after your yes.
- `save_midi_catalog`: saves a sound catalog that Claude drafted from a sound list, after your yes.
- `set_page_requests`: switches how requests typed in the page reach Claude, live or waiting.
- `start`: starts Moontide and opens its page, or says where the page is when it already runs.

## The prompts

Where your Claude offers MCP prompts, three of them are ready to use. In Claude Code they look like this:

- `/mcp__moontide__start` starts Moontide and opens its page.
- `/mcp__moontide__page-requests-on` makes requests from the page reach Claude right away.
- `/mcp__moontide__page-requests-off` makes them wait for Claude's next action.

There is no prompt for music itself. A prompt's text would steer Claude's taste, so a surprise is asked
for in plain words. The tool `set_page_requests` does the same as the two page-request prompts, for
clients that do not offer prompts.

## What was verified

**Verified:**

- The tool list on this page is checked against the tools the running server offers, in a test, at each
  change. So is every tool, prompt, topic and number this manual names.
- The path of a change, the refusals and the history are covered by automated tests, and a drive of the
  real page in headless Chrome checks the page.

**Not verified:**

- That the reasons given here hold up for other uses than the one Moontide was made for.
- That the page and the server behave the same on Windows and Linux; nobody has played music there yet.
