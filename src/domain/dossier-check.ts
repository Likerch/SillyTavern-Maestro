// Dossier (M7 п. 4) structural checks: rules only, no AI. What the stack knows about one entity is passed in as plain
// facts; the result lists issues with the parameters for their text and, where the fix is clear, the keys to add to a
// lorebook entry. Entries of BunnyMo books arrive marked `protected`: they never get a fix (P13) and no Russian forms
// are asked of them.
import { normName, keysCover, isCyrillicPlainKey, nameAgrees, uncoveredForms } from './dossier-names';

export type StructuralKind =
    'missingEntry' | 'missingPassport' | 'missingArchive' | 'aliasNotKey' | 'nameMismatch' | 'formsMissing';

export interface CheckEntry {
    world: string;
    uid: number;
    title: string;
    /** Effective primary keys (the canon override's when there is one). */
    keys: string[];
    /** BunnyMo core or pack (P13). */
    protected: boolean;
}

export interface CheckInput {
    kind: string;
    /** Canonical name of the entity. */
    name: string;
    /** Every other known name (aliases, chat aliases, forms). */
    known: string[];
    /** The entity is in DES (roster, aliases or a tracker). */
    inDes: boolean;
    /** DES canonical name, when DES knows the entity. */
    desCanonical: string | null;
    desAliases: string[];
    entries: CheckEntry[];
    /** Canon items about the entity that are not overrides of `entries` (additions). */
    canonItems: number;
    naiPresent: boolean;
    /** Names of the entity's passports ('' replaced by the card name). */
    passportNames: string[];
    ckPresent: boolean;
    /** `<Name:…>` of each archive (null when an archive has none). */
    archiveNames: (string | null)[];
    /** Case forms of a name (DES-RU); null when DES-RU is not there. */
    formsOf: ((name: string) => string[] | null) | null;
    /** One regex key matching every form (DES-RU); preferred for the fix. */
    formsKeyOf?: ((name: string) => string | null) | null;
}

export interface StructuralIssue {
    kind: StructuralKind;
    severity: 'info' | 'warn';
    params: Record<string, string | number>;
    /** The entry the issue (and its fix) is about. */
    entry?: { world: string; uid: number };
    /** Keys a fix would add to `entry`; absent when there is no safe fix. */
    addKeys?: string[];
}

const PERSONLIKE = new Set(['character', 'persona']);

/** The entry a key fix goes to: the first one outside BunnyMo books. */
function fixTarget(entries: readonly CheckEntry[]): CheckEntry | undefined {
    return entries.find((entry) => !entry.protected);
}

function aliasIssues(input: CheckInput): StructuralIssue[] {
    if (!input.entries.length) return [];
    const issues: StructuralIssue[] = [];
    const target = fixTarget(input.entries);
    const seen = new Set<string>();
    for (const alias of input.desAliases) {
        const norm = normName(alias);
        if (!norm || seen.has(norm) || norm === normName(input.name)) continue;
        seen.add(norm);
        if (input.entries.some((entry) => keysCover(entry.keys, alias))) continue;
        const issue: StructuralIssue = {
            kind: 'aliasNotKey',
            severity: 'warn',
            params: { alias: alias.trim(), entry: (target ?? input.entries[0])?.title ?? '' },
        };
        if (target) {
            issue.entry = { world: target.world, uid: target.uid };
            issue.addKeys = [alias.trim()];
        }
        issues.push(issue);
    }
    return issues;
}

function nameIssues(input: CheckInput): StructuralIssue[] {
    const canonical = input.desCanonical ?? input.name;
    const known = [input.name, ...input.known, ...input.desAliases];
    const odd: string[] = [];
    const add = (name: string | null) => {
        if (!name || !name.trim() || nameAgrees(name, canonical, known)) return;
        if (!odd.some((item) => normName(item) === normName(name))) odd.push(name.trim());
    };
    for (const name of input.archiveNames) add(name);
    for (const name of input.passportNames) add(name);
    if (!odd.length) return [];
    return [{ kind: 'nameMismatch', severity: 'warn', params: { name: canonical, names: odd.join(', ') } }];
}

function formIssues(input: CheckInput): StructuralIssue[] {
    if (!input.formsOf) return [];
    const names = new Set([normName(input.name), ...input.known.map(normName), ...input.desAliases.map(normName)]);
    const issues: StructuralIssue[] = [];
    for (const entry of input.entries) {
        if (entry.protected) continue;
        for (const key of entry.keys) {
            if (!isCyrillicPlainKey(key) || !names.has(normName(key))) continue;
            const forms = input.formsOf(key.trim()) ?? [];
            const missing = uncoveredForms(entry.keys, forms);
            if (!missing.length) continue;
            const regex = input.formsKeyOf?.(key.trim()) ?? null;
            issues.push({
                kind: 'formsMissing',
                severity: 'info',
                params: { key: key.trim(), entry: entry.title, forms: missing.join(', '), count: missing.length },
                entry: { world: entry.world, uid: entry.uid },
                addKeys: regex ? [regex] : missing,
            });
        }
    }
    return issues;
}

/** Structural issues of one entity, in a stable order. */
export function structuralIssues(input: CheckInput): StructuralIssue[] {
    const issues: StructuralIssue[] = [];
    const personlike = PERSONLIKE.has(input.kind);
    if (input.kind === 'character' && input.inDes && !input.entries.length && input.canonItems === 0) {
        issues.push({ kind: 'missingEntry', severity: 'warn', params: { name: input.name } });
    }
    if (personlike && input.naiPresent && !input.passportNames.length && (input.inDes || input.kind === 'persona')) {
        issues.push({ kind: 'missingPassport', severity: 'info', params: { name: input.name } });
    }
    if (input.kind === 'character' && input.ckPresent && !input.archiveNames.length) {
        issues.push({ kind: 'missingArchive', severity: 'info', params: { name: input.name } });
    }
    if (personlike) {
        issues.push(...aliasIssues(input), ...nameIssues(input));
    }
    issues.push(...formIssues(input));
    return issues;
}
