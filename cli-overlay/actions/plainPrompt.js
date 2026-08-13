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
/**
 * Non-Ink entrypoint for editors/extensions: final answer on stdout, status on stderr.
 */
export async function runPlainPrompt({ prompt, thinking = false, quiet = true, search = false, mode = 'normal', }) {
    const token = process.env['DEEPSEEK_TOKEN']?.trim();
    if (!token) {
        console.error('No DeepSeek token found. Run `rc` once to save a token, or set DEEPSEEK_TOKEN.');
        process.exitCode = 1;
        return;
    }
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
        process.stderr.write(`Thinking... (mode=${mode})\n`);
        await getAIResponse({
            token,
            prompt: getChatSystemPrompt(),
            thinkingEnabled: thinking,
            searchEnabled: search,
        });
        const fullResponse = await getAIResponse({
            token,
            prompt,
            confirmTool,
            onToolMessage: (message) => {
                process.stderr.write(`${message}\n`);
            },
            thinkingEnabled: thinking,
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
