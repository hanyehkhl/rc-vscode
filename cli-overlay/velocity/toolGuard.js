const READ_TOOLS = new Set(['read_file']);

const SEARCH_TOOLS = new Set([
    'grep',
    'glob',
    'search',
    'search_files',
    'read_file',
    'list_directory',
    'list_dir',
    'find',
]);

const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'delete_file', 'edit', 'write', 'notebookedit', 'apply_patch']);

/** Hard caps. Below these the guard only advises; it never blinds the model. */
const DUPLICATE_LIMIT = 3;
const SEARCH_LIMIT = 12;

function pathOf(call) {
    const input = call?.input || call?.arguments || {};
    return String(input.path || input.file || '').trim();
}

/**
 * Tool guard for Velocity mode (spawn fallback path).
 *
 * Blocking a tool the model legitimately needs produces a WORSE answer, so this
 * guard is deliberately permissive: re-reading a file after editing it is
 * expected, and only pathological repetition is refused.
 */
export function createToolGuard() {
    let consecutiveSearches = 0;
    const signatures = new Map();

    return {
        async confirmTool(call) {
            const name = String(call?.name || '').toLowerCase();
            const signature = `${name}:${JSON.stringify(call?.input || call?.arguments || {})}`;
            const seen = signatures.get(signature) || 0;

            if (seen >= DUPLICATE_LIMIT) {
                process.stderr.write(`Velocity blocked repeated tool (${seen}x): ${name}\n`);
                return false;
            }
            signatures.set(signature, seen + 1);

            if (EDIT_TOOLS.has(name)) {
                consecutiveSearches = 0;
                // The file changed on disk, so every earlier read of it is stale.
                // Forget those signatures or the model is stuck with old content.
                const target = pathOf(call);
                if (target) {
                    for (const key of [...signatures.keys()]) {
                        if (key.includes(target) && READ_TOOLS.has(key.split(':')[0])) {
                            signatures.delete(key);
                        }
                    }
                }
                return true;
            }

            if (SEARCH_TOOLS.has(name)) {
                consecutiveSearches += 1;
                if (consecutiveSearches > SEARCH_LIMIT) {
                    process.stderr.write(`Velocity blocked search loop after ${SEARCH_LIMIT} lookups: ${name}\n`);
                    return false;
                }
            }

            return true;
        },
    };
}
