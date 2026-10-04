// Tiny YAML editor for SillyTavern's config.yaml: changes one scalar, keeps comments and layout.

/** Replaces the value of a nested key in a YAML text (indentation-based; comments and order are kept). */
export function setYaml(text, keys, value) {
    const lines = text.split('\n');
    let from = 0;
    let parentIndent = -1;
    let at = -1;
    for (const key of keys) {
        let childIndent = null;
        at = -1;
        for (let i = from; i < lines.length; i++) {
            const line = lines[i];
            if (/^\s*(#.*)?$/.test(line)) continue;
            const indent = line.length - line.trimStart().length;
            if (indent <= parentIndent) break;
            childIndent ??= indent;
            if (indent !== childIndent) continue;
            const match = /^\s*([^:#]+?)\s*:(?:\s|$)/.exec(line);
            if (match && match[1].replace(/^['"]|['"]$/g, '') === key) {
                at = i;
                break;
            }
        }
        if (at < 0) return null;
        parentIndent = lines[at].length - lines[at].trimStart().length;
        from = at + 1;
    }
    const match = /^(\s*[^:#]+?\s*:)[^#]*?(\s+#.*)?$/.exec(lines[at]);
    const formatted = typeof value === 'string' ? JSON.stringify(value) : String(value);
    lines[at] = `${match[1]} ${formatted}${match[2] ?? ''}`;
    return lines.join('\n');
}
