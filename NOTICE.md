# Notices and attribution

This repository (`rc-vscode`) is a **VS Code extension** maintained by
**hanyehkhl** (https://github.com/hanyehkhl).

## Upstream project

This extension is built to work with, and is inspired by / derived from:

- **RpCli** by **RezaParsian**
- Repository: https://github.com/RezaParsian/RpCli
- License: MIT
- npm package: `@rezaparsian/rp-cli` (CLI binary `rc`)

RpCli remains the property of its copyright holders. This extension does **not**
claim ownership of RpCli, does **not** use the Marketplace publisher id
`rezaparsian`, and is **not** an official product of RezaParsian unless stated
otherwise by that author.

## Third-party service: AshnaAI

The optional **Ashna** provider in this extension connects to the public
**AshnaAI HTTP API** (https://www.ashna.ai/api-docs) using the user's own API key.

- **AshnaAI**, **Ashna** and related names and logos are the property of their
  respective owner. They are used here only to identify the service this
  extension can connect to (nominative use).
- This extension is **not affiliated with, endorsed by, or sponsored by AshnaAI**.
- **No AshnaAI source code, SDK, assets or logos are included** in this
  extension. The integration is an independent client of the documented,
  OpenAI-compatible HTTP API.
- Use of the Ashna provider is subject to AshnaAI's own Terms of Service
  (https://www.ashna.ai/service-terms) and pricing. Each user supplies their
  own API key; requests are billed to that user's AshnaAI account.
- The extension does **not** ship, share, pool, resell or sublicense API keys
  or AshnaAI credits, does not scrape or reverse-engineer AshnaAI, and does not
  work around rate limits (HTTP 429 is reported to the user, not retried in a
  loop). Requests identify the client with a `User-Agent` of the form
  `rc-vscode/<version>`.
- Users are responsible for keeping their own API key private and for using
  the service in line with AshnaAI's terms.
- The API key is stored locally in VS Code SecretStorage (the OS keychain) and
  is sent only to the configured Ashna API base URL.

## Bundled Node.js runtime

`vendor/node/` contains unmodified **Node.js** binaries (https://nodejs.org),
© OpenJS Foundation and Node.js contributors, distributed under the MIT
License together with the licenses of its bundled third-party components
(see https://github.com/nodejs/node/blob/main/LICENSE).

## What belongs to whom

| Component | Copyright / credit |
|-----------|--------------------|
| Original RpCli CLI and its MIT-licensed source | RezaParsian |
| This VS Code extension (activation, webview UI, token setup UX, packaging) | hanyehkhl |
| Ashna provider integration code in `src/ashna/` (client for the public API) | hanyehkhl |
| AshnaAI service, API, name and trademarks | AshnaAI (third party, not affiliated) |
| Node.js runtime in `vendor/node/` | OpenJS Foundation and Node.js contributors (MIT) |
| Extension Marketplace publisher id `hanyehkhl` | hanyehkhl |

## License compliance

Both the upstream project and this extension are distributed under the **MIT
License**. The full license text is in `LICENSE`. Redistributions must keep the
copyright notices and permission notice.

## Contact

- Extension / this repo: https://github.com/hanyehkhl/rc-vscode
- Upstream RpCli: https://github.com/RezaParsian/RpCli
- AshnaAI API documentation: https://www.ashna.ai/api-docs
