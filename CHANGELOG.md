# Changelog

Notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.1] - 2026-10-11

A maintenance release: nothing changes in how Moontide works.

### Added

- An npm version badge and a CI badge at the top of the README.

### Fixed

- A test wait for server log lines now fails with the log when it times out, instead of passing on quietly.
- Tests that check that something did not happen now make a round trip to the server first, so a slow
  machine cannot pass them too early.
- A test whose server fails to start now stops that server process.
- The wait for the page-request line has the same 10-second bound as the other waits.

## [2.0.0] - 2026-10-11

2.0.0 is the first public release. Earlier versions were never published.

### Added

- An MCP server that lets Claude play Strudel code in a browser page, with tools to write, edit,
  read and stop the code.
- The page: a Strudel editor with a timeline, a mixer, an instruments view and a session drawer.
  You can right-click anything in it to ask Claude about it.
- A session history of every version that plays, with favorites, kept in a local file.
- A factual Strudel reference for the exact Strudel version the page runs.
- MIDI instruments through Web MIDI: instrument and model files, sound catalogs, MIDNAM import
  and MIDI clock.
- Install through npx.
- Moontide starts when you ask for music or say start, not with every Claude session. Each page and its
  tab title name the folder and the port of their server.

[2.0.1]: https://github.com/konni-arcadia/moontide/releases/tag/v2.0.1
[2.0.0]: https://github.com/konni-arcadia/moontide/releases/tag/v2.0.0
