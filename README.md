# RC for VS Code

A VS Code / Cursor chat panel for the [`rc` CLI](https://github.com/RezaParsian/RpCli) (RpCli).

> **Not an official RezaParsian product.**  
> This extension is maintained by [hanyehkhl](https://github.com/hanyehkhl).  
> It is a separate project that **uses / integrates** [RpCli](https://github.com/RezaParsian/RpCli) (MIT).  
> Full attribution: see [`NOTICE.md`](./NOTICE.md) and [`LICENSE`](./LICENSE).

## Credits

- **Upstream CLI:** [RezaParsian/RpCli](https://github.com/RezaParsian/RpCli) — thank you to the original author.
- **This extension:** [hanyehkhl/rc-vscode](https://github.com/hanyehkhl/rc-vscode)

## Features

- Codex-style chat UI
- Modes: Chat · Agent · Agent (Full Access)
- `@` file mentions, `/search`, `/thinking`, `/token`
- Token setup and re-auth when the DeepSeek token expires

## Requirements

1. Node.js 18+
2. RpCli available locally or globally, e.g.:

```bash
npm install --global @rezaparsian/rp-cli
```

Or build from https://github.com/RezaParsian/RpCli and set `rc.cliPath` to `dist/source/cli.js`.

## Develop

```bash
npm install
npm run compile
```

Debug with F5, or package a VSIX:

```bash
npx vsce package
```

## Publish (your publisher only)

Marketplace publisher for this extension: **`hanyehkhl`**

```bash
npx vsce login hanyehkhl
npx vsce publish
```

Do **not** publish under `rezaparsian` unless that publisher account is yours.

## License

MIT — see `LICENSE` (includes copyright notices for RezaParsian and hanyehkhl).
