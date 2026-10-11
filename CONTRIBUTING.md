# Contributing

## Issues

Bug reports and ideas are welcome. Use the bug form for a bug. An idea can be a plain issue.
Never paste anything private: no names, personal paths or tokens.

## Pull requests

Pull requests are welcome and are reviewed in this repository. The code is maintained in a
separate repository, and this one receives each release as a snapshot. So an accepted pull
request is ported there by hand and released in a later version. You are credited as co-author
(a `Co-authored-by` line) in the release commit and in the changelog. The pull request is then
closed with a note that names that version.

## Setup and checks

You need Node 22 or later.

```bash
npm ci
npm run typecheck
npm test
npm run smoke:npx
```

`npm test` builds first. One test starts a server on the default port 5757, so stop any running
Moontide before you run it. `npm run smoke:npx` packs the package and starts it through npx the
way a user does.

## Checking for tint

Run `npm run tint:report -- --last 10` to see the sounds, scales, tempo, flute use and reused
reference lines across your last 10 versions. Run `npm run tint:report -- --ids 12,15,18` to
also compare specific versions to each other (token overlap and identical lines). This is useful
after asking for the same thing more than once. The report only reads your history file on your
machine. It is a measurement for you, never a rule for Claude.

## Security

Report security problems privately, never in an issue or a pull request:
https://github.com/konni-arcadia/moontide/security/policy

## License

Contributions are under the project's license, AGPL-3.0-or-later.
