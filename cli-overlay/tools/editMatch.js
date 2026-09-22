/**
 * Locating `old_text` for edit_file.
 *
 * Models emit tool arguments with LF newlines, while files on Windows are often
 * CRLF, so a plain indexOf fails on every multi-line edit there. Trailing
 * whitespace is the other common near-miss. Matching is done on LF-normalised
 * text and the file's original line endings are restored on write.
 */

function exactMatch(content, needle) {
    const first = content.indexOf(needle);
    if (first === -1)
        return undefined;
    if (content.indexOf(needle, first + 1) !== -1) {
        return { error: 'old_text is not unique in the file. Include more surrounding lines.' };
    }
    return { start: first, end: first + needle.length };
}

/** Line-block match ignoring trailing whitespace on each line. */
function looseLineMatch(content, needle) {
    const contentLines = content.split('\n');
    const needleLines = needle.replace(/\n+$/, '').split('\n').map((line) => line.trimEnd());
    while (needleLines.length > 0 && !needleLines[0].trim())
        needleLines.shift();
    if (needleLines.length === 0)
        return undefined;
    const hits = [];
    for (let i = 0; i + needleLines.length <= contentLines.length; i++) {
        let ok = true;
        for (let j = 0; j < needleLines.length; j++) {
            if (contentLines[i + j].trimEnd() !== needleLines[j]) {
                ok = false;
                break;
            }
        }
        if (ok)
            hits.push(i);
    }
    if (hits.length === 0)
        return undefined;
    if (hits.length > 1) {
        return { error: 'old_text is not unique in the file. Include more surrounding lines.' };
    }
    const offsets = [0];
    for (const line of contentLines)
        offsets.push(offsets[offsets.length - 1] + line.length + 1);
    const startLine = hits[0];
    const endLine = startLine + needleLines.length;
    const end = needle.endsWith('\n') ? offsets[endLine] : offsets[endLine] - 1;
    return { start: offsets[startLine], end: Math.min(end, content.length) };
}

/**
 * Replace one unique occurrence of oldText with newText.
 * Returns the updated file content, or throws with a model-actionable message.
 */
export function applyUniqueEdit(original, oldText, newText) {
    const usesCrlf = original.includes('\r\n');
    const content = usesCrlf ? original.replace(/\r\n/g, '\n') : original;
    const needle = oldText.replace(/\r\n/g, '\n');
    const match = exactMatch(content, needle) ?? looseLineMatch(content, needle);
    if (!match) {
        throw new Error('old_text was not found in the file. Re-read the file and copy the lines verbatim.');
    }
    if ('error' in match)
        throw new Error(match.error);
    let updated = content.slice(0, match.start) + newText.replace(/\r\n/g, '\n') + content.slice(match.end);
    if (usesCrlf)
        updated = updated.replace(/\n/g, '\r\n');
    return updated;
}
