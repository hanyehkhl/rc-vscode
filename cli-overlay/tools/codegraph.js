/**
 * Semantic / symbol code search via CodeGraphContext (`cgc` CLI).
 *
 * The optional Python package is installed by the VS Code extension into a
 * private venv and exposed to the CLI through `RC_CGC_BIN`. When that env var
 * is unset, indexing fails, or the graph is not ready yet, every call degrades
 * to literal substring search without surfacing an error to the agent.
 */

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { substringSearch } from './substringSearch.js';

const execFileAsync = promisify(execFile);

export const CODE_SEARCH_MAX_RESULTS = 30;
const FIND_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

/** Per-workspace index jobs so two concurrent searches do not start two indexers. */
const indexJobs = new Map();

function cgcBin() {
    return String(process.env.RC_CGC_BIN || '').trim();
}

function cgcDatabaseArgs() {
    // FalkorDB Lite is not the default on Windows; KuzuDB is the portable embedded backend.
    if (process.platform === 'win32') {
        return ['--database', 'kuzudb'];
    }
    return [];
}

async function cgcExists() {
    const bin = cgcBin();
    if (!bin)
        return false;
    try {
        await access(bin);
        return true;
    }
    catch {
        return false;
    }
}

async function runCgc(args, cwd, timeoutMs) {
    const bin = cgcBin();
    const { stdout, stderr } = await execFileAsync(bin, [...cgcDatabaseArgs(), ...args], {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: process.env,
    });
    return `${stdout}\n${stderr}`;
}

/**
 * Parse `cgc find` human output into `path:line:snippet` rows.
 *
 * Typical block:
 *   1. sendPaymentConfirmation
 *      File: src/email/notifications.py:45
 */
export function parseCgcFindOutput(text, rootDirectory, maxResults = CODE_SEARCH_MAX_RESULTS) {
    const results = [];
    const seen = new Set();
    const lines = text.split(/\r?\n/);
    let pendingName = '';

    for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        const line = lines[i];
        const numbered = /^\s*\d+\.\s+(.+)$/.exec(line);
        if (numbered) {
            pendingName = numbered[1].trim();
            continue;
        }
        const fileMatch = /File:\s*(.+?):(\d+)\s*$/.exec(line);
        if (!fileMatch)
            continue;

        let filePath = fileMatch[1].trim().replace(/\\/g, '/');
        if (path.isAbsolute(filePath)) {
            filePath = path.relative(rootDirectory, filePath).split(path.sep).join('/');
        }
        const lineNo = fileMatch[2];
        const snippet = pendingName || filePath;
        const key = `${filePath}:${lineNo}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        results.push(`${filePath}:${lineNo}:${snippet}`);
        pendingName = '';
    }

    // Fallback: bare `File:` references without numbered list formatting.
    if (results.length === 0) {
        const fileRe = /File:\s*(.+?):(\d+)/g;
        let match;
        while ((match = fileRe.exec(text)) !== null && results.length < maxResults) {
            let filePath = match[1].trim().replace(/\\/g, '/');
            if (path.isAbsolute(filePath)) {
                filePath = path.relative(rootDirectory, filePath).split(path.sep).join('/');
            }
            const key = `${filePath}:${match[2]}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            results.push(`${filePath}:${match[2]}:[cgc match]`);
        }
    }

    return results;
}

async function isIndexed(rootDirectory) {
    try {
        const output = await runCgc(['list'], rootDirectory, LIST_TIMEOUT_MS);
        const normalizedRoot = path.resolve(rootDirectory);
        const normalizedOutput = output.replace(/\\/g, '/');
        return normalizedOutput.includes(normalizedRoot.replace(/\\/g, '/'));
    }
    catch {
        return false;
    }
}

function startBackgroundIndex(rootDirectory) {
    if (indexJobs.has(rootDirectory))
        return indexJobs.get(rootDirectory);

    const bin = cgcBin();
    const child = spawn(bin, [...cgcDatabaseArgs(), 'index', rootDirectory], {
        cwd: rootDirectory,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: process.env,
    });
    child.unref();

    const job = new Promise((resolve) => {
        child.on('error', () => resolve(false));
        child.on('exit', (code) => resolve(code === 0));
    }).finally(() => {
        indexJobs.delete(rootDirectory);
    });

    indexJobs.set(rootDirectory, job);
    return job;
}

async function runFindStrategies(query, rootDirectory) {
    const strategies = [
        ['find', 'pattern', query],
        ['find', 'name', query],
        ['find', 'content', query],
    ];
    const merged = [];
    const seen = new Set();

    for (const args of strategies) {
        if (merged.length >= CODE_SEARCH_MAX_RESULTS)
            break;
        try {
            const output = await runCgc(args, rootDirectory, FIND_TIMEOUT_MS);
            for (const row of parseCgcFindOutput(output, rootDirectory, CODE_SEARCH_MAX_RESULTS - merged.length)) {
                if (seen.has(row))
                    continue;
                seen.add(row);
                merged.push(row);
            }
        }
        catch {
            // try the next strategy
        }
    }
    return merged;
}

/**
 * Search the repository. Uses CodeGraphContext when available; otherwise, or
 * while the index is building, falls back to substring search.
 */
export async function searchCode(query, rootDirectory, searchPath = '.') {
    const scopedRoot = path.resolve(rootDirectory, searchPath === '.' ? '.' : searchPath);
    const relative = path.relative(rootDirectory, scopedRoot);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('The requested path is outside the current working directory.');
    }

    if (!(await cgcExists())) {
        const fallback = await substringSearch(query, rootDirectory, searchPath);
        return prefixNote(fallback, '[substring search — CodeGraphContext not available]');
    }

    const indexed = await isIndexed(rootDirectory);
    if (!indexed) {
        startBackgroundIndex(rootDirectory);
        const fallback = await substringSearch(query, rootDirectory, searchPath);
        return prefixNote(fallback, '[substring search — code graph index is building in the background; retry search_code in a minute]');
    }

    try {
        const semantic = await runFindStrategies(query, rootDirectory);
        if (semantic.length > 0) {
            const scoped = semantic.filter((row) => {
                const file = row.split(':')[0];
                if (!relative || relative === '.')
                    return true;
                const prefix = relative.split(path.sep).join('/');
                return file === prefix || file.startsWith(`${prefix}/`);
            });
            if (scoped.length > 0)
                return scoped;
            if (searchPath === '.' || !relative || relative === '.')
                return semantic;
        }
    }
    catch {
        // fall through to substring
    }

    const fallback = await substringSearch(query, rootDirectory, searchPath);
    return prefixNote(fallback, '[substring search — semantic search returned no matches]');
}

function prefixNote(lines, note) {
    if (!Array.isArray(lines) || lines.length === 0)
        return [note, '(no matches)'];
    return [note, ...lines];
}
