import { promises as fs } from 'node:fs';
import path from 'node:path';
import listWorkspaceFiles from '../core/ListWorkspaceFiles.js';

export const SUBSTRING_SEARCH_MAX_LINES = 50;
export const SUBSTRING_SEARCH_MAX_FILE_BYTES = 100 * 1024;

async function listSearchFiles(directory, rootDirectory) {
    const relativeDirectory = path.relative(rootDirectory, directory).split(path.sep).join('/');
    const files = await listWorkspaceFiles(rootDirectory);
    return files
        .filter((file) => {
            if (!relativeDirectory || relativeDirectory === '.')
                return true;
            return file === relativeDirectory || file.startsWith(`${relativeDirectory}/`);
        })
        .map((file) => path.join(rootDirectory, file));
}

/**
 * Literal substring search — the fallback when semantic search is unavailable
 * or the code graph index is not ready yet.
 */
export async function substringSearch(query, rootDirectory, searchPath = '.') {
    const directory = path.resolve(rootDirectory, searchPath);
    const relative = path.relative(rootDirectory, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('The requested path is outside the current working directory.');
    }
    const files = await listSearchFiles(directory, rootDirectory);
    const matches = [];
    for (const filePath of files) {
        if (matches.length >= SUBSTRING_SEARCH_MAX_LINES)
            break;
        const stats = await fs.stat(filePath);
        if (stats.size > SUBSTRING_SEARCH_MAX_FILE_BYTES)
            continue;
        const content = await fs.readFile(filePath, 'utf8');
        for (const [index, line] of content.split('\n').entries()) {
            if (line.includes(query)) {
                matches.push(`${path.relative(rootDirectory, filePath)}:${index + 1}:${line}`);
                if (matches.length >= SUBSTRING_SEARCH_MAX_LINES)
                    break;
            }
        }
    }
    return matches;
}
