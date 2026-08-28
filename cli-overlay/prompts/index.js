import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getToolDescriptions } from '../tools/index.js';

const promptsDirectory = path.dirname(fileURLToPath(import.meta.url));

function loadPrompt(name) {
    return fs.readFileSync(path.join(promptsDirectory, name), 'utf8');
}

export function readAgentsMarkdown(cwd = process.cwd()) {
    const filePath = path.join(path.resolve(cwd), './AGENTS.md');
    if (!fs.existsSync(filePath))
        return '';
    return fs.readFileSync(filePath, 'utf8');
}

function buildToolsPrompt() {
    const toolsList = getToolDescriptions()
        .map((description, index) => `${index + 1}. ${description}`)
        .join('\n');
    const elevationHint = process.platform === 'win32'
        ? 'If administrator rights are needed, include the word `sudo` in the command (for example `sudo netstat -ab`). RP-CLI does not run a sudo binary on Windows; it strips `sudo` and opens a UAC dialog instead.'
        : 'If administrator rights are needed, include `sudo` in the command (anywhere, not only at the start). RP-CLI strips `sudo` and opens an OS authorization dialog. There is no separate elevated tool.';
    return loadPrompt('tools.md')
        .replace('{{toolsList}}', toolsList)
        .replace('{{elevationHint}}', elevationHint);
}

export function SystemPrompt() {
    const toolsPrompt = buildToolsPrompt();
    const agentPrompt = readAgentsMarkdown();
    let systemPrompt = loadPrompt('system.md')
        .replace('{{platform}}', process.platform)
        .replace('{{cwd}}', process.cwd())
        .replace('{{tools}}', toolsPrompt);
    if (agentPrompt !== '')
        systemPrompt +=
            "\n\n---\n\n# Project-Specific Context (from this repository's AGENTS.md — treat as ground truth for this project)\n\n" +
                agentPrompt;
    return systemPrompt;
}

export function ServerSystemPrompt(cwd = process.cwd()) {
    const resolvedCwd = path.resolve(cwd);
    const toolsPrompt = buildToolsPrompt();
    let systemPrompt = loadPrompt('server.md')
        .replace('{{platform}}', process.platform)
        .replace('{{cwd}}', resolvedCwd)
        .replace('{{tools}}', toolsPrompt);
    const agentPrompt = readAgentsMarkdown(resolvedCwd);
    if (agentPrompt !== '')
        systemPrompt +=
            "\n\n---\n\n# Project-Specific Context (from this repository's AGENTS.md — treat as ground truth for this project)\n\n" +
                agentPrompt;
    return systemPrompt;
}

export function InitPrompt() {
    return loadPrompt('init.md');
}

export function ContinuePrompt() {
    return loadPrompt('continue.md');
}

export function GitCommitMessage() {
    return loadPrompt('gitMessage.md');
}

export function PlanPrompt(task) {
    return loadPrompt('plan.md').replace('{{task}}', task);
}

export function ExecutePlanPrompt(mode) {
    return loadPrompt('executePlan.md').replace('{{mode}}', mode);
}

export function resolveServeMode(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'plan' || normalized === 'normal' || normalized === 'yolo')
        return normalized;
    return 'plan';
}
