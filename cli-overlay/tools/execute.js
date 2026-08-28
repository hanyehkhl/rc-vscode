import { createPathContext } from './paths.js';
import { tools } from './registry.js';
import { commandNeedsElevation } from './sudo.js';

function formatToolOutput(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value))
        return value.join('\n');
    if (value && typeof value === 'object' && ('stdout' in value || 'stderr' in value)) {
        const { stdout, stderr } = value;
        const parts = [];
        if (stdout?.trim())
            parts.push(stdout.trimEnd());
        if (stderr?.trim())
            parts.push(`stderr:\n${stderr.trimEnd()}`);
        return parts.length > 0 ? parts.join('\n\n') : '(no output)';
    }
    return JSON.stringify(value, null, 2);
}

export async function executeTool(call, signal, pathContext) {
    const ctx = pathContext ?? createPathContext();
    const tool = tools.find((candidate) => candidate.name === call.name);
    if (!tool)
        return { ok: false, tool_name: call.name, error: 'Unknown tool' };
    try {
        const result = await tool.execute(call.arguments, signal, ctx);
        return { ok: true, tool_name: call.name, result: formatToolOutput(result) };
    }
    catch (error) {
        return {
            ok: false,
            tool_name: call.name,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function executeToolCalls(calls, onConfirm, mode, signal, pathContext) {
    const results = [];
    let declined = false;
    for (const call of calls) {
        if (signal?.aborted)
            break;
        if (declined) {
            results.push({
                ok: false,
                tool_name: call.name,
                error: 'Skipped: a previous tool call in this batch was declined.',
            });
            continue;
        }
        if (mode === 'plan' && toolIsMutating(call)) {
            results.push({
                ok: false,
                tool_name: call.name,
                error: 'Plan mode is read-only. File changes and shell commands are blocked. Describe the plan instead. After you present a plan, wait for the user to approve it.',
            });
            continue;
        }
        if (toolRequiresConfirmation(call, mode)) {
            let confirmed;
            try {
                confirmed = await onConfirm(call);
            }
            catch (error) {
                results.push({
                    ok: false,
                    tool_name: call.name,
                    error: `Could not prepare confirmation: ${error instanceof Error ? error.message : String(error)}`,
                });
                continue;
            }
            if (!confirmed) {
                declined = true;
                results.push({
                    ok: false,
                    tool_name: call.name,
                    error: 'User declined this action.',
                });
                continue;
            }
        }
        results.push(await executeTool(call, signal, pathContext));
    }
    return results;
}

export function toolIsMutating(call) {
    if (commandNeedsElevation(call))
        return true;
    return tools.find((tool) => tool.name === call.name)?.requiresConfirmation ?? false;
}

export function toolRequiresConfirmation(call, mode) {
    if (mode === 'plan')
        return false;
    if (commandNeedsElevation(call))
        return true;
    if (mode === 'yolo')
        return false;
    return tools.find((tool) => tool.name === call.name)?.requiresConfirmation ?? false;
}
