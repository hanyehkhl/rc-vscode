import { deleteSession, isInvalidTokenError } from '../../core-lib/index.js';
import { getAIResponse, getChatSystemPrompt } from './agent.js';

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
        return false;
    }
    process.env.RC_THINKING_EFFORT = effort === 'low' ? 'low' : effort === 'hard' ? 'max' : 'high';
    if (effort === 'hard' && !search) {
        process.env.RC_MODEL_TYPE = 'expert';
    } else {
        delete process.env.RC_MODEL_TYPE;
    }
    return true;
}

/**
 * Non-Ink entrypoint for editors/extensions: final answer on stdout, status on stderr.
 */
export async function runPlainPrompt({ prompt, thinking = false, thinkingEffort, quiet = true, search = false, mode = 'normal', }) {
    const token = process.env['DEEPSEEK_TOKEN']?.trim();
    if (!token) {
        console.error('No DeepSeek token found. Run `rc` once to save a token, or set DEEPSEEK_TOKEN.');
        process.exitCode = 1;
        return;
    }
    const effort = resolveThinkingEffort(thinkingEffort, thinking);
    const thinkingEnabled = applyThinkingEnv(effort, search);
    const confirmTool = async (call) => {
        if (call.name === 'run_command_elevated') {
            process.stderr.write(`Declined elevated command in plain mode: ${call.name}\n`);
            return false;
        }
        if (mode === 'plan') {
            return false;
        }
        process.stderr.write(`Approved tool: ${call.name}\n`);
        return true;
    };
    try {
        process.stderr.write(`Thinking... (mode=${mode}, effort=${effort})\n`);
        await getAIResponse({
            token,
            prompt: getChatSystemPrompt(),
            thinkingEnabled,
            searchEnabled: search,
        });
        const fullResponse = await getAIResponse({
            token,
            prompt: withThinkingEffort(prompt, effort),
            confirmTool,
            onToolMessage: (message) => {
                process.stderr.write(`${message}\n`);
            },
            thinkingEnabled,
            onChunk: (chunk) => {
                if (chunk.type === 'thinking' && !quiet) {
                    process.stderr.write(chunk.content);
                }
            },
            searchEnabled: search,
            mode,
        });
        const finalText = (fullResponse.content ?? '').trim() || 'Ai Error!';
        process.stdout.write(`${finalText}\n`);
        await deleteSession(token, fullResponse.sessionId).catch(() => undefined);
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
}
