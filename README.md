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
- `@` file mentions, `/search`, `/thinking`, `/velocity`, `/token`
- **Velocity mode** — faster, more focused agent (Python daemon + session reuse + tool guard)
- Token setup and re-auth when the DeepSeek token expires

## Requirements

- A DeepSeek token (`/token` or **RC: Set DeepSeek Token**)

Node.js **and** the `rc` CLI are bundled inside the extension.  
You do **not** need to install Node, npm, or RpCli on the machine.

**Velocity mode** additionally needs **Python 3.11+** on the machine (or `py -3` on Windows). The extension starts the bundled daemon automatically when Velocity is enabled.

## Develop

```bash
npm install
npm run compile
```
# ساخت فایل VSIX

## مراحل

**۱.** وارد پوشه پروژه شو:
```
cd rc-vscode
```

**۲.** پکیج‌ها رو نصب کن:
```
npm install
```

**۳.** کد رو کامپایل کن:
```
npm run compile
```

**۴.** فایل vsix رو بساز:
```
npm run package
```

این دستور از `vsce` (که تو devDependencies هست) استفاده می‌کنه و یه فایل مثل:
```
rc-vscode-0.1.0.vsix
```
تو همون پوشه می‌سازه.

**۵.** برای نصبش تو VSCode:
```
code --install-extension rc-vscode-0.1.0.vsix
```
## License

MIT — see `LICENSE` (includes copyright notices for RezaParsian and hanyehkhl).
