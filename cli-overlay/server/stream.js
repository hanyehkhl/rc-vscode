export function writeSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function writeNamedSse(res, eventName, payload) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function streamChunk(res, id, created, model, delta, finishReason = null) {
    writeSse(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        system_fingerprint: null,
        choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    });
}

export function streamToolEvent(res, payload) {
    writeNamedSse(res, 'rp_tool', payload);
}
