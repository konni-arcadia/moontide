# MVP

## Scope

1. The user opens the Moontide page and clicks once to unlock audio (a browser rule).
2. The user asks Claude, through MCP, to start music from a theme or an inspiration.
3. Claude writes Strudel code. The code appears in the page's editor and starts playing.
4. The user asks for changes. Claude edits the code, and the sound changes on the next cycle.
5. If the code fails to evaluate, the page reports the error back to Claude so it can fix it.

## After the MVP

- MIDI output to hardware. Strudel already handles port, channel, program change, CC and
  sysex.
- Sync with other gear.
- A simple way to describe an instrument rig (ports, channels, sounds, useful CCs) so that
  Claude can drive it fluently. Let real use shape this format rather than designing it
  up front.
- Keep the current code in a real file on disk, so the human and Claude can both edit it.
