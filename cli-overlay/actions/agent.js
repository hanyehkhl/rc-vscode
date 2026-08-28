import sendMessage, { beginGeneration, isGenerationStopped } from '../core/apiClient.js';
import { SystemPrompt } from '../prompts/index.js';
import { createPathContext } from '../tools/paths.js';
import { executeToolCalls, formatToolActivityMessage, parseToolCalls } from '../tools/index.js';

export function getChatSystemPrompt() {
    return SystemPrompt();
}

/** Structured event on stderr so the editor can render a tool timeline. */
function emitEvent(name, payload) {
    if (process.env.RC_EVENTS !== '1') {
        return;
    }
    try {
        process.stderr.write(`RC_EVENT ${name} ${JSON.stringify(payload ?? {})}\n`);
    }
    catch {
        // never let telemetry break a run
    }
}

function formatResultsMessage(results) {
    const blocks = results
        .map((result) => {
        const body = result.ok ? result.result ?? '' : `Error: ${result.error}`;
        return `<tool_result name="${result.tool_name}" ok="${result.ok}">\n${body}\n</tool_result>`;
    })
        .join('\n');
    return `${blocks}\nUse these results to continue answering the user's request.`;
}

function formatToolResultsForDisplay(results) {
    const lines = results.map((result) => {
        if (!result.ok) {
            return `❌ ${result.tool_name}: ${result.error}`;
        }
        const output = result.result?.trim() || '(no output)';
        return `⚙️ ${result.tool_name}:\n${output}`;
    });
    return lines.join('\n\n');
}

const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'delete_file']);

function callPath(call) {
    const args = call?.arguments || call?.input || {};
    return String(args.path || '').trim();
}

function maxToolRounds() {
    const raw = Number.parseInt(process.env.RC_MAX_TOOL_ROUNDS || '', 10);
    if (Number.isFinite(raw) && raw > 0 && raw <= 200) {
        return raw;
    }
    return 10;
}

function toolRoundLimitMessage(limit) {
    return `Stopped after ${limit} tool rounds. Type /continue to keep going.`;
}

export async function getAIResponse({ token, prompt, confirmTool, onToolMessage, onToolEvent, thinkingEnabled = true, onChunk, searchEnabled = false, mode = 'normal', toolsEnabled = true, modelType = 'default', cwd, }) {
    const signal = beginGeneration();
    const limit = maxToolRounds();
    const pathContext = createPathContext(cwd);
    let toolRoundLimitReached = false;
    const send = (nextPrompt) => sendMessage({
        token,
        prompt: nextPrompt,
        thinkingEnabled,
        searchEnabled,
        modelType,
        onChunk,
    });
    let response = await send(prompt);
    if (!toolsEnabled) {
        return { ...response, toolRoundLimitReached: false };
    }
    let toolRounds = 0;
    while (true) {
        if (response.stopped || isGenerationStopped())
            return { ...response, toolRoundLimitReached };
        let toolCalls;
        try {
            toolCalls = parseToolCalls(response.content || '');
        }
        catch (error) {
            if (toolRounds >= limit) {
                toolRoundLimitReached = true;
                emitEvent('limit', { rounds: toolRounds, reason: 'parse' });
                onToolEvent?.({ type: 'tool_limit', rounds: toolRounds, reason: 'parse' });
                onToolMessage?.(toolRoundLimitMessage(limit));
                return { ...response, toolRoundLimitReached: true };
            }
            toolRounds += 1;
            response = await send(`The tool call could not be parsed: ${error instanceof Error ? error.message : String(error)}. Send a corrected tool call or answer without a tool.`);
            continue;
        }
        if (toolCalls.length === 0)
            return { ...response, toolRoundLimitReached };
        if (toolRounds >= limit) {
            toolRoundLimitReached = true;
            emitEvent('limit', { rounds: toolRounds, reason: 'rounds' });
            onToolEvent?.({ type: 'tool_limit', rounds: toolRounds, reason: 'rounds' });
            onToolMessage?.(toolRoundLimitMessage(limit));
            response = await send('Maximum tool call rounds reached. Summarize what you finished and what remains. Do not use tools. Tell the user they can type /continue to keep working.');
            return { ...response, toolRoundLimitReached: true };
        }
        toolRounds += 1;
        emitEvent('round', { round: toolRounds, calls: toolCalls.map((call) => call.name) });
        for (const call of toolCalls) {
            const payload = { type: 'tool_start', name: call.name, path: callPath(call) || undefined };
            emitEvent('tool_start', payload);
            onToolEvent?.(payload);
        }
        onToolMessage?.(formatToolActivityMessage(response.content ?? '', toolCalls));
        const results = await executeToolCalls(toolCalls, async (call) => (confirmTool ? confirmTool(call) : false), mode, signal, pathContext);
        if (isGenerationStopped())
            return { ...response, toolRoundLimitReached };
        results.forEach((result, index) => {
            const payload = {
                type: 'tool_result',
                name: result.tool_name,
                ok: Boolean(result.ok),
                error: result.ok ? undefined : String(result.error ?? ''),
                bytes: result.ok ? String(result.result ?? '').length : 0,
            };
            emitEvent('tool_result', payload);
            onToolEvent?.(payload);
            const call = toolCalls[index];
            if (result.ok && call && EDIT_TOOLS.has(call.name)) {
                const target = callPath(call);
                if (target) {
                    emitEvent('edited', { path: target });
                }
            }
        });
        const displayMessage = formatToolResultsForDisplay(results);
        if (displayMessage) {
            onToolMessage?.(displayMessage);
        }
        response = await send(formatResultsMessage(results));
    }
}
