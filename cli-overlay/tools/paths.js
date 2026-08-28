import { promises as fs } from 'node:fs';
import path from 'node:path';

/** @deprecated Use createPathContext(cwd) — kept for callers that still import the name. */
export const rootDirectory = process.cwd();

export async function safePath(rootDirectory, requestedPath) {
    const resolvedPath = path.resolve(rootDirectory, requestedPath);
    const relativePath = path.relative(rootDirectory, resolvedPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error('The requested path is outside the current working directory.');
    }
    const realPath = await fs.realpath(resolvedPath);
    const realRoot = await fs.realpath(rootDirectory);
    const realRelativePath = path.relative(realRoot, realPath);
    if (realRelativePath.startsWith('..') || path.isAbsolute(realRelativePath)) {
        throw new Error('The requested path resolves outside the current working directory.');
    }
    return realPath;
}

export async function safeTargetPath(rootDirectory, requestedPath) {
    const resolvedPath = path.resolve(rootDirectory, requestedPath);
    const relativePath = path.relative(rootDirectory, resolvedPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error('The requested path is outside the current working directory.');
    }
    const parent = await safePath(rootDirectory, path.dirname(requestedPath));
    return path.join(parent, path.basename(resolvedPath));
}

export function createPathContext(cwd = process.cwd()) {
    const root = path.resolve(cwd);
    return {
        rootDirectory: root,
        safePath: (requestedPath) => safePath(root, requestedPath),
        safeTargetPath: (requestedPath) => safeTargetPath(root, requestedPath),
    };
}
