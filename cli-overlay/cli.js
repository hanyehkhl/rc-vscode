#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import meow from 'meow';
import dotenv from 'dotenv';
import { tokenConfigPath } from './core/TokenConfig.js';
dotenv.config({
    path: tokenConfigPath,
    quiet: true,
});
const { default: App } = await import('./app.js');
const cli = meow(`
	Usage
	  $ rc                           Open interactive chat
	  $ rc <prompt>                  Send a single prompt
	  $ rc -t <prompt>               Send a prompt with thinking enabled
	  $ rc -tq <prompt>              Think silently and show only the answer
	  $ rc -s <prompt>               Enable web search for a prompt
	  $ rc -c / --commit-message     Generate commit message from staged changes
	  $ rc -c -a                     Use git diff HEAD instead of --staged
	  $ rc --plain "question"        Print answer to stdout (for editors)
	  $ rc --plain --mode auto "..." Auto-approve edits (yolo)

	Options
	  --commit-message, -c  Generate commit message from staged changes
	  --commit-all, -a      Use git diff HEAD instead of --staged (use with -c)
	  --thinking, -t        Enable thinking for a single prompt (medium)
	  --thinking-effort     off|low|medium|hard (overrides --thinking)
	  --quiet, -q           Hide thinking output from a single prompt
	  --search, -s          Enable web search for a single prompt
	  --plain               Non-interactive stdout mode (no Ink TUI)
	  --mode <mode>         With --plain: ask|plan, write|normal, auto|yolo
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
        mode: { type: 'string', default: 'write' },
    },
});
const prompt = cli.input.join(' ').trim();
if (cli.flags.plain) {
    if (!prompt) {
        console.error('Error: --plain requires a prompt argument');
        process.exit(1);
    }
    const { resolveAgentMode, resolveThinkingEffort, runPlainPrompt } = await import('./actions/plainPrompt.js');
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
const mode = cli.flags.commitMessage ? 'commit' : prompt ? 'prompt' : 'interactive';
render(React.createElement(App, { mode: mode, commitAll: cli.flags.commitAll ?? false, prompt: prompt, thinking: cli.flags.thinking ?? false, quiet: cli.flags.quiet ?? false, search: cli.flags.search ?? false, version: cli.pkg.version }), {
    exitOnCtrlC: false,
    kittyKeyboard: { mode: 'enabled' },
});
