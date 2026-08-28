#!/usr/bin/env node
import meow from 'meow';
import dotenv from 'dotenv';
import { tokenConfigPath } from './core/TokenConfig.js';
dotenv.config({
    path: tokenConfigPath,
    quiet: true,
});
const cli = meow(`
	Usage
	  $ rc                           Open interactive chat
	  $ rc <prompt>                  Send a single prompt
	  $ rc -t <prompt>               Send a prompt with thinking enabled
	  $ rc -tq <prompt>              Think silently and show only the answer
	  $ rc -s <prompt>               Enable web search for a prompt
	  $ rc -c / --commit-message     Generate commit message from staged changes
	  $ rc -c -a                     Use git diff HEAD instead of --staged
	  $ rc serve                     Start an OpenAI-compatible HTTP API
	  $ rc serve --port 8080         Start server on custom port
	  $ rc serve --host 127.0.0.1    Bind to specific host
	  $ rc --plain "question"        Print answer to stdout (for editors)
	  $ rc --plain --stdin           Read the prompt from stdin (no argv limit)
	  $ rc --plain --mode auto "..." Auto-approve edits (yolo)

	Options
	  --commit-message, -c  Generate commit message from staged changes
	  --commit-all, -a      Use git diff HEAD instead of --staged (use with -c)
	  --thinking, -t        Enable thinking for a single prompt (medium)
	  --thinking-effort     off|low|medium|hard (overrides --thinking)
	  --quiet, -q           Hide thinking output from a single prompt
	  --search, -s          Enable web search for a single prompt
	  --plain               Non-interactive stdout mode (no Ink TUI)
	  --stdin               With --plain: read the prompt from stdin
	  --delete-session <id> Delete a chat session and exit
	  --mode <mode>         With --plain: ask|plan, write|normal, auto|yolo
	  --port, -p            Port to listen on (default: 3000)
	  --host                Host to bind to (default: 127.0.0.1)
	  --version             Show version

	Examples
	  $ rc
	  $ rc "explain bubble sort in 2 sentences"
	  $ rc -t "solve this step by step"
	  $ rc -tq "say 1"
	  $ rc --plain "say hi"
	  $ rc --plain --mode write "@main.py add a route"
	  $ rc -c
	  $ rc -c -a
	  $ rc serve
	  $ rc serve --port 8080
`, {
    importMeta: import.meta,
    flags: {
        commitMessage: { type: 'boolean', shortFlag: 'c' },
        commitAll: { type: 'boolean', shortFlag: 'a' },
        thinking: { type: 'boolean', shortFlag: 't' },
        thinkingEffort: { type: 'string' },
        quiet: { type: 'boolean', shortFlag: 'q' },
        search: { type: 'boolean', shortFlag: 's' },
        plain: { type: 'boolean', default: false },
        stdin: { type: 'boolean', default: false },
        deleteSession: { type: 'string' },
        mode: { type: 'string', default: 'write' },
        port: { type: 'string', shortFlag: 'p' },
        host: { type: 'string' },
    },
});
const firstArg = cli.input[0];
if (cli.flags.deleteSession) {
    // Editors keep one DeepSeek session per chat thread; this removes it when
    // the user starts a new chat so sessions do not pile up on their account.
    const { deleteSession } = await import('../core-lib/index.js');
    const token = process.env['DEEPSEEK_TOKEN']?.trim();
    if (token) {
        await deleteSession(token, cli.flags.deleteSession).catch(() => undefined);
    }
    process.exit(0);
}
if (cli.flags.plain) {
    const { readStdin, resolveAgentMode, resolveThinkingEffort, runPlainPrompt } = await import('./actions/plainPrompt.js');
    const prompt = (cli.flags.stdin ? await readStdin() : cli.input.join(' ')).trim();
    if (!prompt) {
        console.error('Error: --plain requires a prompt argument (or --stdin)');
        process.exit(1);
    }
    await runPlainPrompt({
        prompt,
        thinking: cli.flags.thinking ?? false,
        thinkingEffort: resolveThinkingEffort(cli.flags.thinkingEffort, cli.flags.thinking ?? false),
        quiet: cli.flags.quiet ?? true,
        search: cli.flags.search ?? false,
        mode: resolveAgentMode(cli.flags.mode),
    });
    const code = process.exitCode ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.exit(code);
}
if (firstArg === 'serve') {
    const { startServer } = await import('./server/index.js');
    const port = cli.flags.port ? parseInt(cli.flags.port, 10) : undefined;
    const host = cli.flags.host;
    await startServer({ port, host });
}
else {
    const { render } = await import('ink');
    const { default: App } = await import('./app.js');
    const React = await import('react');
    const prompt = cli.input.join(' ').trim();
    const mode = cli.flags.commitMessage ? 'commit' : prompt ? 'prompt' : 'interactive';
    render(React.createElement(App, {
        mode,
        commitAll: cli.flags.commitAll ?? false,
        prompt,
        thinking: cli.flags.thinking ?? false,
        quiet: cli.flags.quiet ?? false,
        search: cli.flags.search ?? false,
        version: cli.pkg.version,
    }), {
        exitOnCtrlC: false,
        kittyKeyboard: { mode: 'enabled' },
    });
}
