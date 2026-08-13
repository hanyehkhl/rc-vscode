# How to put this on YOUR GitHub (no rights conflict)

This extension is **yours to publish** under GitHub/`publisher` **hanyehkhl**, while
crediting upstream **RpCli** (MIT) by RezaParsian.

## Already set in this repo

| Field | Value |
|-------|--------|
| Marketplace `publisher` | `hanyehkhl` |
| GitHub author | https://github.com/hanyehkhl |
| Intended repo | https://github.com/hanyehkhl/rc-vscode |
| Upstream credit | `LICENSE`, `NOTICE.md`, `README.md`, `contributors` |

## Local git (already prepared)

```powershell
cd "C:\codes\r and d\claudee\rc-vscode"
# git init + first commit were done locally — do NOT push until you want to
```

When **you** decide to publish the remote:

```powershell
gh repo create hanyehkhl/rc-vscode --public --source=. --remote=origin
git push -u origin HEAD
```

(or create the empty repo on GitHub first, then `git remote add origin ...` and push)

## Marketplace

1. Create publisher **hanyehkhl** at https://marketplace.visualstudio.com/manage  
   (must match `package.json` → `publisher`)
2. `npx vsce login hanyehkhl`
3. `npx vsce publish`

Never use publisher id `rezaparsian` unless that account is yours.

## Legal checklist (MIT-friendly)

- [x] Keep MIT `LICENSE` with RezaParsian + your copyright
- [x] Keep `NOTICE.md` / README “unofficial / based on RpCli”
- [x] Your `publisher` / `author` / `repository` point to you
- [x] Do not claim to be the official RpCli author
- [x] Do not commit secrets (`.env`, tokens)
