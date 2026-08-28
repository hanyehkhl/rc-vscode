import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec as execCallback } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { stringArgument, textArgument } from './arguments.js';
import { createPathContext } from './paths.js';
import { commandContainsSudo, stripSudo } from './sudo.js';
import { searchCode } from './codegraph.js';
import { substringSearch } from './substringSearch.js';
import { todoTools } from './todo.js';
import {
    emitEvent,
    hookShutdown,
    runSandboxed,
    sandboxImage,
    sandboxMode,
    sandboxNetworkAllowed,
} from './sandbox.js';

/**
 * Wall-clock ceiling for a sandboxed command, enforced inside the guest by the
 * SDK's exec timeout. The host path has no timeout today, so this is applied
 * only to the sandboxed path to avoid changing existing behaviour.
 */
const SANDBOX_TIMEOUT_MS = Math.max(0, Number.parseInt(process.env.RC_SANDBOX_TIMEOUT_MS || '', 10) || 600_000);

const require = createRequire(import.meta.url);
const legacyUtil = require('node:util');
legacyUtil.isFunction ?? (legacyUtil.isFunction = (value) => typeof value === 'function');
legacyUtil.isObject ?? (legacyUtil.isObject = (value) => value !== null && (typeof value === 'object' || typeof value === 'function'));
const { exec: sudoExecCallback } = require('@slosk/sudo-prompt');
const exec = promisify(execCallback);

function commandEnv() {
    const env = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (value === undefined)
            continue;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
            continue;
        if (/[\r\n]/.test(value))
            continue;
        env[name] = value;
    }
    return env;
}

function elevatedExec(command) {
    return new Promise((resolve, reject) => {
        sudoExecCallback(command, { name: 'RP CLI', env: commandEnv() }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({
                stdout: stdout?.toString() ?? '',
                stderr: stderr?.toString() ?? '',
            });
        });
    });
}

function resolvePathContext(pathContext) {
    return pathContext ?? createPathContext();
}

export const tools = [
    {
        name: 'list_directory',
        description: 'list_directory(path?: string) - Lists files and directories at a path inside the current working directory.',
        requiresConfirmation: false,
        async execute(arguments_, _signal, pathContext) {
            const { safePath } = resolvePathContext(pathContext);
            const requestedPath = stringArgument(arguments_, 'path', '.');
            const directory = await safePath(requestedPath);
            const entries = await fs.readdir(directory, { withFileTypes: true });
            return entries.map((entry) => `${entry.isDirectory() ? 'directory' : 'file'}\t${entry.name}`);
        },
    },
    {
        name: 'write_file',
        description: 'write_file(path: string, content: string) - Creates or completely overwrites a UTF-8 file inside the current working directory. Use this when the user asks for a file; do not paste the contents in the chat.',
        requiresConfirmation: true,
        async execute(arguments_, _signal, pathContext) {
            const { safeTargetPath } = resolvePathContext(pathContext);
            const filePath = await safeTargetPath(stringArgument(arguments_, 'path'));
            const content = textArgument(arguments_, 'content');
            await fs.writeFile(filePath, content, 'utf8');
            return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes.`;
        },
    },
    {
        name: 'edit_file',
        description: 'edit_file(path: string, old_text: string, new_text: string) - Replaces one unique exact text occurrence in a UTF-8 file.',
        requiresConfirmation: true,
        async execute(arguments_, _signal, pathContext) {
            const { safePath } = resolvePathContext(pathContext);
            const filePath = await safePath(stringArgument(arguments_, 'path'));
            const oldText = stringArgument(arguments_, 'old_text');
            const newText = textArgument(arguments_, 'new_text');
            const content = await fs.readFile(filePath, 'utf8');
            const firstIndex = content.indexOf(oldText);
            if (firstIndex === -1)
                throw new Error('old_text was not found in the file.');
            if (content.indexOf(oldText, firstIndex + oldText.length) !== -1) {
                throw new Error('old_text is not unique in the file.');
            }
            await fs.writeFile(filePath, content.slice(0, firstIndex) + newText + content.slice(firstIndex + oldText.length), 'utf8');
            return 'File edited successfully.';
        },
    },
    {
        name: 'delete_file',
        description: 'delete_file(path: string) - Deletes one file inside the current working directory.',
        requiresConfirmation: true,
        async execute(arguments_, _signal, pathContext) {
            const { safePath } = resolvePathContext(pathContext);
            const filePath = await safePath(stringArgument(arguments_, 'path'));
            const stats = await fs.stat(filePath);
            if (!stats.isFile())
                throw new Error('The requested path is not a file.');
            await fs.unlink(filePath);
            return 'File deleted successfully.';
        },
    },
    {
        name: 'read_file',
        description: 'read_file(path: string) - Reads a UTF-8 text file inside the current working directory (maximum 100 KiB).',
        requiresConfirmation: false,
        async execute(arguments_, _signal, pathContext) {
            const { safePath } = resolvePathContext(pathContext);
            const filePath = await safePath(stringArgument(arguments_, 'path'));
            const stats = await fs.stat(filePath);
            if (!stats.isFile())
                throw new Error('The requested path is not a file.');
            if (stats.size > 100 * 1024)
                throw new Error('The requested file is larger than 100 KiB.');
            return fs.readFile(filePath, 'utf8');
        },
    },
    {
        name: 'search_code',
        description: 'search_code(query: string, path?: string) - PRIMARY code search. Finds functions, classes, and symbols by name or meaning using a code graph (fuzzy/symbol match). Returns up to 30 hits as path:line:snippet. Falls back to literal substring search automatically while the index builds or if CodeGraphContext is unavailable. Use this first for "where is X", "find the retry logic", or any symbol lookup.',
        requiresConfirmation: false,
        async execute(arguments_, _signal, pathContext) {
            const ctx = resolvePathContext(pathContext);
            const query = stringArgument(arguments_, 'query');
            const searchPath = stringArgument(arguments_, 'path', '.');
            await ctx.safePath(searchPath);
            return searchCode(query, ctx.rootDirectory, searchPath);
        },
    },
    {
        name: 'search_files',
        description: 'search_files(query: string, path?: string) - Literal substring search only (line.includes). Use when you know the exact text to grep for, or when search_code is unavailable. Returns up to 50 matching lines. NOT for symbol or semantic lookup — use search_code instead.',
        requiresConfirmation: false,
        async execute(arguments_, _signal, pathContext) {
            const ctx = resolvePathContext(pathContext);
            const query = stringArgument(arguments_, 'query');
            const searchPath = stringArgument(arguments_, 'path', '.');
            await ctx.safePath(searchPath);
            return substringSearch(query, ctx.rootDirectory, searchPath);
        },
    },
    {
        name: 'run_command',
        description: 'run_command(command: string) - Runs a shell command in the current working directory. Include sudo anywhere in the command when administrator privileges are needed; an OS authorization dialog will open.',
        requiresConfirmation: true,
        async execute(arguments_, signal, pathContext) {
            const ctx = resolvePathContext(pathContext);
            const command = stringArgument(arguments_, 'command');
            const mode = sandboxMode();
            const wantsSudo = commandContainsSudo(command);

            if (mode !== 'off') {
                hookShutdown();
                // Inside the guest the user is already root and no `sudo` binary
                // exists, so sudo is stripped and the command runs as root in the
                // microVM. The host `elevatedExec` path — an OS authorization
                // dialog reachable from a model-authored string — is never taken
                // while sandboxing is active. Keeping it would defeat the feature.
                const sandboxCommand = wantsSudo ? stripSudo(command) : command;
                if (wantsSudo && !sandboxCommand)
                    throw new Error('sudo was given with no command.');

                const result = await runSandboxed(sandboxCommand, ctx.rootDirectory, signal, SANDBOX_TIMEOUT_MS);

                if (result.supported) {
                    emitEvent('sandbox', {
                        sandboxed: true,
                        image: sandboxImage(),
                        network: sandboxNetworkAllowed() ? 'allow' : 'deny',
                        strippedSudo: wantsSudo || undefined,
                    });
                    // The model is told where this ran. An agent that believes it
                    // touched the host when it did not will misread its own results.
                    const banner = wantsSudo
                        ? `[sandboxed: microVM, workspace mounted at /workspace, network ${sandboxNetworkAllowed() ? 'allowed' : 'denied'}; sudo ignored — already root in the VM]`
                        : `[sandboxed: microVM, workspace mounted at /workspace, network ${sandboxNetworkAllowed() ? 'allowed' : 'denied'}]`;
                    return {
                        stdout: `${banner}\n${result.stdout}`,
                        stderr: result.stderr,
                    };
                }

                // `require` refuses rather than silently running unsandboxed. This
                // is the setting a cautious user running `rc serve` should pick.
                if (mode === 'require') {
                    emitEvent('sandbox', { sandboxed: false, refused: true, reason: result.reason });
                    throw new Error(`Refusing to run this command: sandboxing is required but unavailable — ${result.reason}. ` +
                        `Set rc.sandbox.mode to "auto" to allow running on the host instead.`);
                }

                emitEvent('sandbox', { sandboxed: false, reason: result.reason });
            }

            if (wantsSudo) {
                const elevatedCommand = stripSudo(command);
                if (!elevatedCommand)
                    throw new Error('sudo was given with no command.');
                return elevatedExec(elevatedCommand);
            }
            const { stdout, stderr } = await exec(command, {
                cwd: ctx.rootDirectory,
                maxBuffer: 1024 * 1024,
                signal,
            });
            return { stdout, stderr };
        },
    },
    ...todoTools,
];

export function getToolDescriptions() {
    return tools.map((tool) => tool.description);
}
