import path from 'node:path';
import { getAIResponse } from '../actions/agent.js';
import { chatSessionExists, getCurrentSessionId, resetChatSession, setCurrentSessionId } from '../core/apiClient.js';
import { ServerSystemPrompt, resolveServeMode } from '../prompts/index.js';

let completionQueue = Promise.resolve();
let initializedSessionToken;
const sessionTools = new Map();

export function getSessionTools(sessionId) {
    return sessionId ? sessionTools.get(sessionId) : undefined;
}

export function rememberSessionTools(sessionId, tools) {
    if (sessionId)
        sessionTools.set(sessionId, tools);
}

export function enqueueCompletion(task) {
    const run = completionQueue.then(task, task);
    completionQueue = run.then(() => undefined, () => undefined);
    return run;
}

function resolveServeCwd(metadata) {
    const raw = metadata?.cwd;
    if (typeof raw === 'string' && raw.trim())
        return path.resolve(raw.trim());
    return process.cwd();
}

function createServeConfirmTool(mode) {
    if (mode === 'plan')
        return undefined;
    return async () => true;
}

export async function runCompletion(options) {
    if (options.shouldAbort())
        return { stopped: true, ok: true, sessionId: '', content: '', thinkingContent: '', toolRoundLimitReached: false };
    const mode = resolveServeMode(options.metadata?.mode);
    const cwd = resolveServeCwd(options.metadata);
    const confirmTool = createServeConfirmTool(mode);
    const common = {
        token: options.token,
        thinkingEnabled: options.thinkingEnabled,
        searchEnabled: options.searchEnabled,
        onChunk: options.onChunk,
        onToolEvent: options.onToolEvent,
        mode,
        cwd,
        confirmTool,
        toolsEnabled: true,
    };
    if (initializedSessionToken !== undefined && initializedSessionToken !== options.token) {
        resetChatSession();
        initializedSessionToken = undefined;
    }
    if (options.sessionId) {
        const sessionExists = await chatSessionExists(options.token, options.sessionId);
        if (getCurrentSessionId() !== options.sessionId)
            setCurrentSessionId(options.sessionId);
        initializedSessionToken = sessionExists ? options.token : undefined;
    }
    if (initializedSessionToken !== options.token) {
        await getAIResponse({
            ...common,
            prompt: ServerSystemPrompt(cwd),
            searchEnabled: false,
        });
        initializedSessionToken = options.token;
    }
    if (options.shouldAbort())
        return { stopped: true, ok: true, sessionId: '', content: '', thinkingContent: '', toolRoundLimitReached: false };
    const result = await getAIResponse({
        ...common,
        prompt: options.prompt,
    });
    return {
        stopped: result.stopped,
        ok: result.ok,
        sessionId: result.sessionId,
        content: result.content,
        thinkingContent: result.thinkingContent,
        tokenUsage: result.tokenUsage,
        error: result.error,
        toolRoundLimitReached: Boolean(result.toolRoundLimitReached),
    };
}
