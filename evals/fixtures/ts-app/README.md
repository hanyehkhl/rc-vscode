# fixture-ts-app

A deliberately small task-list core, used as a fixture for the RC eval harness.

- `src/task.ts` — the `Task` type and its priority scale
- `src/store.ts` — in-memory store, the only thing that mutates tasks
- `src/format.ts` — rendering tasks as text
- `src/validate.ts` — input validation
- `src/config.ts` — runtime settings
- `src/index.ts` — wires the pieces together

Run `npm run typecheck` to check it.
