import { deleteSession, isInvalidTokenError } from '../../core-lib/index.js';
import { getCurrentSessionId, setCurrentSessionId } from '../core/apiClient.js';
import { getAIResponse, getChatSystemPrompt } from './agent.js';
import { createToolGuard } from '../velocity/toolGuard.js';
import { shutdownSandbox } from '../tools/sandbox.js';

/** Tools that cannot change the workspace. Allowed even in read-only chat mode. */
const READ_ONLY_TOOLS = new Set([
    'read_file',
    'list_directory',
    'search_files',
    'todo_add',
    'todo_list',
    'todo_update',
    'todo_split',
    'todo_clear',
]);

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

export function resolveAgentMode(value) {
    const normalized = (value ?? 'normal').trim().toLowerCase();
    if (normalized === 'ask' || normalized === 'plan')
        return 'plan';
    if (normalized === 'auto' || normalized === 'yolo')
        return 'yolo';
    if (normalized === 'write' || normalized === 'normal')
        return 'normal';
    return 'normal';
}

export function resolveThinkingEffort(value, thinkingFlag = false) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === 'off' || normalized === 'low' || normalized === 'medium' || normalized === 'hard') {
        return normalized;
    }
    return thinkingFlag ? 'medium' : 'off';
}

/**
 * Grounding rules appended to the system prompt.
 *
 * The single largest source of bad code from this model is answering about code
 * it never opened: invented function names, wrong signatures, edits against
 * remembered rather than actual file content. These rules target exactly that.
 */
const GROUNDING_RULES = `
## Grounding rules (highest priority)

**Never describe, call, or edit code you have not read in this conversation.**
Before referring to a function, type, constant, or file, open it with \`read_file\`.
If you catch yourself about to write "it probably", "this likely", or "should be" —
stop and read the file instead.

- Do not invent APIs, flags, parameters, config keys, or file paths. If you need
  one and cannot find it, search for it; if it does not exist, say so plainly.
- Match the surrounding code: its language version, imports, naming, error
  handling, and formatting. Do not introduce a new library, framework, or style
  that the project does not already use.
- Before an \`edit_file\`, re-read the exact region if anything has changed it since
  you last saw it. \`old_text\` must be copied verbatim from a real read — never
  retyped from memory.
- Change only what the task requires. Do not reformat, rename, or "tidy"
  unrelated code, and never delete code you do not understand.
- After editing, state what you changed and what you did NOT verify. If the
  change needs a build, test, or manual check to be trusted, say so.
- When the request is ambiguous in a way that changes the code, ask one specific
  question instead of guessing and writing the wrong thing.
- "I do not know" and "I could not find it" are correct answers. A confident
  wrong answer is the worst outcome.
`;

const EFFORT_INSTRUCTIONS = {
    low: 'Use light reasoning. Keep the chain of thought brief and answer quickly.',
    medium: 'Think carefully before answering. Check the important details, then give a clear answer.',
    hard: 'Think as thoroughly as possible. Consider edge cases, alternatives, and verify the plan before acting. Prefer a complete, careful solution over speed.',
};

function withThinkingEffort(prompt, effort) {
    const instruction = EFFORT_INSTRUCTIONS[effort];
    if (!instruction) {
        return prompt;
    }
    return `[Thinking intensity: ${effort.toUpperCase()}]\n${instruction}\n\n${prompt}`;
}

function applyThinkingEnv(effort, search) {
    if (effort === 'off') {
        delete process.env.RC_THINKING_EFFORT;
        delete process.env.RC_MODEL_TYPE;
        return { thinkingEnabled: false, modelType: 'default' };
    }
    // Chat.js overlay maps these into DeepSeek thinking_mode / reasoning_effort.
    process.env.RC_THINKING_EFFORT = effort === 'low' ? 'low' : effort === 'hard' ? 'max' : 'high';
    const useExpert = effort === 'hard' && !search;
    if (useExpert) {
        process.env.RC_MODEL_TYPE = 'expert';
    }
    else {
        delete process.env.RC_MODEL_TYPE;
    }
    return {
        thinkingEnabled: true,
        modelType: useExpert ? 'expert' : 'default',
    };
}

/**
 * Read the prompt from stdin.
 *
 * argv has a hard length limit (~32 KiB on Windows) that a prompt carrying
 * workspace context and conversation history exceeds easily.
 */
export function readStdin() {
    return new Promise((resolve, reject) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => {
            data += chunk;
        });
        process.stdin.on('end', () => resolve(data));
        process.stdin.on('error', reject);
    });
}

/**
 * Non-Ink entrypoint for editors/extensions: final answer on stdout, status and
 * structured `RC_EVENT` lines on stderr.
 */
export async function runPlainPrompt({ prompt, thinking = false, thinkingEffort, quiet = true, search = false, mode = 'normal', }) {
    const token = process.env['DEEPSEEK_TOKEN']?.trim();
    if (!token) {
        console.error('No DeepSeek token found. Run `rc` once to save a token, or set DEEPSEEK_TOKEN.');
        process.exitCode = 1;
        return;
    }
    const effort = resolveThinkingEffort(thinkingEffort, thinking);
    const { thinkingEnabled, modelType } = applyThinkingEnv(effort, search);

    // Reuse the DeepSeek session across turns so the model keeps the real
    // conversation (and the system prompt) instead of a re-pasted transcript.
    const resumeSessionId = (process.env.RC_SESSION_ID || '').trim();
    const keepSession = process.env.RC_KEEP_SESSION === '1';
    if (resumeSessionId) {
        setCurrentSessionId(resumeSessionId);
    }

    // Chat mode must not modify the workspace, but it still needs to READ it —
    // a model that cannot open a file can only guess about the code.
    const readOnly = mode === 'plan';
    const velocityEnabled = process.env.RC_VELOCITY_ENABLED === '1';
    const toolGuard = velocityEnabled ? createToolGuard() : undefined;

    const confirmTool = async (call) => {
        const name = String(call?.name || '');
        if (name === 'run_command_elevated') {
            process.stderr.write(`Declined elevated command in plain mode: ${name}\n`);
            emitEvent('tool_denied', { name, reason: 'elevated' });
            return false;
        }
        if (readOnly && !READ_ONLY_TOOLS.has(name)) {
            process.stderr.write(`Declined ${name}: chat mode is read-only.\n`);
            emitEvent('tool_denied', { name, reason: 'read_only' });
            return false;
        }
        if (toolGuard && !(await toolGuard.confirmTool(call))) {
            emitEvent('tool_denied', { name, reason: 'guard' });
            return false;
        }
        process.stderr.write(`Approved tool: ${name}\n`);
        return true;
    };

    try {
        process.stderr.write(`Thinking... (mode=${mode}, effort=${effort}, model=${modelType}, readOnly=${readOnly})\n`);

        // The system prompt only needs to be sent once per session. On a resumed
        // session it is already the first message, so re-sending it would waste a
        // full generation on every turn.
        const groundingRules = process.env.RC_GROUNDING === '0' ? '' : GROUNDING_RULES;
        const finalPrompt = resumeSessionId
            ? withThinkingEffort(prompt, effort)
            : `${getChatSystemPrompt()}\n${groundingRules}\n---\n\n${withThinkingEffort(prompt, effort)}`;

        const fullResponse = await getAIResponse({
            token,
            prompt: finalPrompt,
            confirmTool,
            onToolMessage: (message) => {
                process.stderr.write(`${message}\n`);
            },
            thinkingEnabled,
            onChunk: (chunk) => {
                if (chunk.type === 'response') {
                    emitEvent('delta', { t: chunk.content });
                }
                else if (chunk.type === 'thinking' && !quiet) {
                    process.stderr.write(chunk.content);
                }
            },
            searchEnabled: search,
            mode,
            modelType,
            toolsEnabled: true,
        });

        const sessionId = fullResponse.sessionId || getCurrentSessionId() || '';
        if (sessionId) {
            emitEvent('session', { id: sessionId });
        }
        const finalText = (fullResponse.content ?? '').trim() || 'Ai Error!';
        process.stdout.write(`${finalText}\n`);

        if (!velocityEnabled && !keepSession && sessionId) {
            await deleteSession(token, sessionId).catch(() => undefined);
        }
    }
    catch (error) {
        if (isInvalidTokenError(error)) {
            console.error('RC_INVALID_TOKEN');
            console.error('Invalid DeepSeek token. Run `rc` to set a new token.');
            process.exitCode = 1;
            return;
        }
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
    finally {
        // cli.js calls process.exit() straight after this returns, and an
        // 'exit' handler cannot await. Tearing the microVM down here is the
        // only point where the shutdown can actually be waited on.
        await shutdownSandbox();
    }
}
