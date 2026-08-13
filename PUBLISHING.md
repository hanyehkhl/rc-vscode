# Publish under your name (hanyehkhl)

## Already configured

| Field | Value |
|-------|--------|
| `publisher` | `hanyehkhl` |
| Author / GitHub | https://github.com/hanyehkhl |
| Repo URL in package.json | https://github.com/hanyehkhl/rc-vscode |
| Upstream credit | `LICENSE`, `NOTICE.md`, README |

This is an **unofficial** extension that integrates [RezaParsian/RpCli](https://github.com/RezaParsian/RpCli) (MIT). You keep your own publisher id; you do **not** use `rezaparsian`.

## Local git

A local `main` commit exists in this folder. **No remote push was done.**

When you want to put it on GitHub yourself:

```powershell
cd "C:\codes\r and d\claudee\rc-vscode"
gh repo create hanyehkhl/rc-vscode --public --source=. --remote=origin
git push -u origin main
```

## Marketplace (optional)

1. Create publisher `hanyehkhl` at https://marketplace.visualstudio.com/manage
2. `npx vsce login hanyehkhl`
3. `npx vsce publish`
