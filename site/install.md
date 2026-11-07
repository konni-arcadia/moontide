# Install

This page adds Moontide to Claude, shows how to update it and how to remove it, and ends with your
first music. The short version, for someone who already has Node 22 or later and Claude Code:

```bash
claude mcp add --scope user moontide -- npx -y moontide-mcp
```

Then start a new Claude session and ask for music. The sections below explain each part.

## What you need

- **Node 22 or later**, with npm and npx (they come with Node).
- **Claude Code or Claude Desktop.** Moontide is an MCP server: Claude talks to it.
- **Chrome**, the browser Moontide was tried with. For MIDI (Web MIDI), use Chrome or Edge.
- **Internet access**: Strudel and its sounds load from the web.
- **Speakers or headphones.**

## Check Node

In a terminal, run:

```bash
node --version
```

It must print `v22` or higher. If Node is missing or older, install the LTS version from
[nodejs.org](https://nodejs.org). On macOS with Homebrew, `brew install node` works too. Open a
new terminal afterwards and check again.

## Get Claude

Install Claude Code or Claude Desktop from [claude.com](https://claude.com/claude-code) and sign
in once. Moontide works with either; Claude Code is the one tried most.

## Add Moontide to Claude

Pick the one that matches how you use Claude.

### Claude Code

Tested on macOS. Linux is untested.

In a terminal, run:

```bash
claude mcp add --scope user moontide -- npx -y moontide-mcp
```

With `--scope user`, Moontide is available in every folder. The default scope (local) works only
in the folder where you ran the command, and the scope `project` shares it through a `.mcp.json`
file.

Keep the name `moontide`. The page-request commands in this manual use it.

Check the install with:

```bash
claude mcp get moontide
```

The same line is meant for Linux. It is untested there.

### Claude Desktop

Tested on macOS. Windows is untested. Claude Desktop has no Linux version.

Open Settings, then Developer, then Edit Config. The file is:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add Moontide to it:

```json
{
  "mcpServers": {
    "moontide": {
      "command": "npx",
      "args": ["-y", "moontide-mcp"]
    }
  }
}
```

If the file already has an `mcpServers` block, add the `moontide` entry inside it. Quit Claude
Desktop fully and start it again.

### Windows with Claude Code

Untested.

From PowerShell or Command Prompt (not Git Bash), run:

```bash
claude mcp add --scope user moontide -- cmd /c npx -y moontide-mcp
```

Check it with `claude mcp get moontide`. The command must read `cmd` with `/c npx -y moontide-mcp`.
If it shows `C:/` instead of `/c`, edit the `moontide` entry in the `.claude.json` file of your
user folder so it reads `"command": "cmd", "args": ["/c", "npx", "-y", "moontide-mcp"]`.

This form comes from community reports. It has not been tried here.

### Running from the source code

To run Moontide from a copy of its repository instead of npm:

```bash
git clone https://github.com/konni-arcadia/moontide.git
cd moontide
npm ci
npm run build
```

Then add it with the full path of `dist/index.js`, written here as `<folder>`:

```bash
claude mcp add --scope user moontide -- node <folder>/dist/index.js
```

`npm test` runs the test suite. The real-browser checks (`npm run probe:page`) need Chrome.

## First music

1. Start a new Claude session. Nothing opens yet: Moontide waits until you want it.
2. Ask for music, for example "Play something calm to start the day" or "Give me a slow, warm
   groove". Or say "start Moontide". In Claude Code, `/mcp__moontide__start` does the same.
3. The page opens in a new tab at http://localhost:5757, or on another port when 5757 is busy.
   Claude's replies name the address.
4. Click once anywhere in the page. Browsers start sound only after a click.
5. Ask for changes: "darker", "add a bass", "slower".

Set `MOONTIDE_NO_BROWSER=1` in the environment and starting Moontide opens no tab. Open the
address from Claude's reply yourself.

## Update

To see the version that runs, run `npx -y moontide-mcp --version`. Releases are listed in
[CHANGELOG.md](https://github.com/konni-arcadia/moontide/blob/main/CHANGELOG.md). npx can keep
using a copy it already downloaded; to move to the newest release, add Moontide again with
`@latest`:

```bash
claude mcp remove moontide --scope user
claude mcp add --scope user moontide -- npx -y moontide-mcp@latest
```

## Uninstall

```bash
claude mcp remove moontide --scope user
```

In Claude Desktop, remove the `moontide` entry from the config file and restart it. Moontide keeps
its history and settings in your data folder; delete that folder if you want them gone too.

## What was verified

**Verified:**

- The Claude Code line and the Claude Desktop config, on macOS with Chrome.
- The first start through npx from the registry, on macOS.

**Not verified:**

- Claude Code on Linux.
- Claude Code and Claude Desktop on Windows.
- The advice to put the full path of npx in the Claude Desktop config when it does not find npx.
- Browsers other than Chrome.
- A first npx start on Linux and Windows.
