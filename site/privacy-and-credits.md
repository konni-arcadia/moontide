# Network, privacy, credits and license

This page says what Moontide sends over the network and to whom, how to report a bug or a security
problem, whose work Moontide builds on, and under which license it is shared.

## Network and privacy

- The server listens on 127.0.0.1 only. That address is your own computer, so no other computer can
  reach it. The server also refuses a request that asks for it under any other host name.
- Moontide's own server code makes no outbound request and sends no telemetry.
- The page loads `@strudel/repl` 1.3.0 and `acorn` 8.18.0 from unpkg. Both are pinned to exact versions
  with integrity hashes, so the browser refuses a file that is not the one that was pinned.
- Strudel then fetches sound lists and samples from raw.githubusercontent.com and cdn.jsdelivr.net. No
  hash covers those.
- The code Claude writes runs in the page and may load samples from other addresses.
- The history stays in the local data folder, as the [History and favorites](history.md) page says.

### What keeps other programs out

Four checks guard the page's channel to the server, and they protect different things.

- **The host check** keeps a request that comes under another name out. If a request asks for the
  server under a name other than localhost, 127.0.0.1 or the loopback address of IPv6, with the port the
  server really uses, the server answers with a refusal. It does so before it reads the page, so the
  page's token is never in a refused answer.
- **The origin check** keeps other websites out. A browser always tells a server the real address of the
  page that opens a connection, and a web page cannot fake it. A website you visit therefore cannot talk
  to Moontide.
- **The page token** changes at every start and is written into the page the server serves. The server
  needs it for every message from the page and before a connection can become the active page. A
  connection without it gets nothing, and its other messages are ignored and logged. This refuses a stale
  page and a page this Moontide did not serve. It is not a secret from a program on your own computer:
  any local program that can load the page, and any code running in the page, can read it.
- **The listener token** is given only to Claude, in a tool reply. It is the real boundary for your
  requests: no other program can receive what you type in the page without it, and no web page can take
  the place of Claude's listener, because a listener connection that carries an origin is refused. On a
  computer shared with other people, the listener token can be seen in the list of running processes
  while the listener runs.

Every kind of refusal is written to the server's log, and the page shows each refusal it receives.

## Reporting a bug and security problems

Bug reports and ideas are welcome as issues (use the bug form). How pull requests are handled is in
[CONTRIBUTING.md](https://github.com/konni-arcadia/moontide/blob/main/CONTRIBUTING.md). Never paste
anything private in an issue: no names, personal paths or tokens.

Security problems go through a private report, never a public issue. See
https://github.com/konni-arcadia/moontide/security/policy.

## Credits

This builds on other people's work:

- **Felix Roos, Alex McLean and the Strudel contributors**: [Strudel](https://strudel.cc)
  (source: https://codeberg.org/uzu/strudel), the live-coding engine that plays every note.
- **Alex McLean and the TidalCycles community**: TidalCycles, the pattern language Strudel ports to
  JavaScript.
- **The sample makers** whose sets Strudel loads by default, including the TidalCycles Dirt-Samples and
  the Versilian Community Sample Library (VCSL).
- **Anthropic**: the Model Context Protocol and its TypeScript SDK, which let Claude talk to Moontide.
- **The acorn authors**: the JavaScript parser the page uses to read the code.

## License

Moontide plays Strudel, which is under AGPL-3.0-or-later. Moontide uses the same license. It loads
Strudel from unpkg at run time and does not ship it. The license text is in
[LICENSE](https://github.com/konni-arcadia/moontide/blob/main/LICENSE). Moontide is not affiliated with,
or endorsed by, the Strudel or TidalCycles projects, or Anthropic.

## What was verified

**Verified:**

- The host check, the origin check and the two tokens are covered by automated tests: a request under
  another host name is refused 403 and its answer holds no token, the loopback names are the only ones
  accepted, a connection from a foreign origin, with no origin or with the origin "null" is refused, a
  listener connection that carries an origin or a wrong token is refused, and two sessions never share a
  token.
- A test reads the pinned Strudel version, its address and the start of its integrity hash from the page.

**Not verified:**

- The sound lists and samples Strudel fetches carry no hash, and the code Claude writes may load samples
  from other addresses, so what those files hold is not checked.
- No test proves that the server makes no outbound request or sends no telemetry. This comes from reading
  the sources, which hold no such call.
- That the integrity hash of acorn matches the file unpkg serves today, and what a pinned file holds beyond
  its hash: the browser checks the hash when it loads the file, and no test of this project does.
