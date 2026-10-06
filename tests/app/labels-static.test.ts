// @vitest-environment happy-dom
// Static guard of plan-2 §3 «Понятные уведомления»: every action kind Maestro passes to autonomy.decide / inbox.add /
// journal.record / registerApplier / neverAuto needs a human label `kind.<kind>` (en + ru), and every journal target
// with an undo handler needs a description (MaestroModule.targets or a `target.<target>` label). The scan reads the
// sources — `kind:` properties, `*_KIND` constants, the first argument of the registration calls, kind templates —
// so a new kind without a label fails here instead of reaching the user as `wardrobe.outfit`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MODULES } from '../../src/app/registry';
import { CORE_STRINGS } from '../../src/core/strings';
import { UI_STRINGS } from '../../src/ui/views/strings';

const ROOT = resolve(__dirname, '../../src');

/** Modules another pass rewrites (plan-2 §3 follow-up): only they may have kinds and targets on the lists below. */
const PENDING_FOLDERS = ['wardrobe', 'world', 'dossier', 'voices', 'sheets', 'lorePassports', 'loreStudio'];

/**
 * Kinds and targets of those modules that still lack labels. Remove an entry as soon as it gets one — the test fails
 * for a listed item that is already labelled, so the list stays honest.
 */
const PENDING_KINDS: string[] = [
    'lore.save',
    'lore.settings',
    'wardrobe.outfit',
    'wardrobe.placeState',
    'wardrobe.state',
    'wardrobe.wear',
    'world.alias',
    'world.separate',
];
const PENDING_TARGETS: string[] = [
    'dossier-canon',
    'dossier-chat-alias',
    'dossier-entry',
    'dossier-note',
    'dossier-passport',
    'dossier-place',
    'dossier-styleup',
    'dossier-styleup-part',
    'lore-passport',
    'lore-studio-binding',
    'lore-studio-book',
    'lore-studio-entry',
    'lore-studio-settings',
    'sheets.hidden',
    'sheets.text',
    'wardrobe.passport',
    'world-alias',
    'world-merge',
    'world-separate',
];

/** Dotted `kind:` values that are not actions: entity sources of the dossier and the world model, revision signals. */
const NOT_ACTION_KINDS = new Set([
    'memory.important',
    'fact.new',
    'des.character',
    'canon.entry',
    'lore.entry',
    'ck.archive',
    'nai.passport',
    'qvink.memory',
]);

/**
 * Kinds built from templates (`kind: \`quality.${…}\``): every expansion is checked; 'signal' marks bus signals,
 * 'pending' a template of a module on PENDING_FOLDERS. A new template must be added here.
 */
const TEMPLATES: Record<string, string[] | 'signal' | 'pending'> = {
    'quality.*': [
        'language',
        'userSpeech',
        'refusal',
        'moralizing',
        'softening',
        'repetition',
        'truncated',
        'junk',
        'missingTracker',
        'canonContradiction',
        'boundary',
    ].map((kind) => `quality.${kind}`),
    'promise.*': 'signal',
    'lore.book.*': 'pending',
    'lore.binding.*': 'pending',
};

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (path.endsWith('.ts')) out.push(path);
    }
    return out;
}

interface SourceFile {
    path: string;
    rel: string;
    text: string;
    /** String constants: NAME → values (objects and arrays give several). */
    constants: Map<string, string[]>;
    /** Imported name → the file it comes from. */
    imports: Map<string, string>;
}

const FILES: SourceFile[] = walk(ROOT).map((path) => {
    const text = readFileSync(path, 'utf8');
    const constants = new Map<string, string[]>();
    for (const match of text.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*'([^']+)'/g)) {
        constants.set(match[1]!, [match[2]!]);
    }
    for (const match of text.matchAll(
        /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*[[{]([\s\S]*?)[\]}]/g,
    )) {
        const values = [...match[2]!.matchAll(/'([^']+)'/g)].map((item) => item[1]!);
        if (values.length && !constants.has(match[1]!)) constants.set(match[1]!, values);
    }
    const imports = new Map<string, string>();
    for (const match of text.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
        if (!match[2]!.startsWith('.')) continue;
        const target = resolve(dirname(path), `${match[2]!}.ts`);
        for (const part of match[1]!.split(',')) {
            const [name, alias] = part.trim().split(/\s+as\s+/);
            if (name) imports.set((alias ?? name).trim(), target);
        }
    }
    return { path, rel: relative(ROOT, path).replace(/\\/g, '/'), text, constants, imports };
});
const BY_PATH = new Map(FILES.map((file) => [file.path, file]));

function resolveName(file: SourceFile, name: string, depth = 0): string[] {
    const own = file.constants.get(name);
    if (own) return own;
    const from = file.imports.get(name);
    const source = from ? BY_PATH.get(from) : undefined;
    return source && depth < 3 ? resolveName(source, name, depth + 1) : [];
}

function folderOf(rel: string): string {
    const parts = rel.split('/');
    return parts[0] === 'features' ? (parts[1] ?? '') : (parts[0] ?? '');
}

const CALLS = /autonomy\.decide|\.decide\s*[<(]|inbox\.add\(|journal\.record\(|registerApplier\(|neverAuto\(/;

interface Scan {
    kinds: Map<string, Set<string>>;
    /** Templates not listed in TEMPLATES. */
    unknownTemplates: string[];
    pendingTemplates: Set<string>;
}

function scanKinds(): Scan {
    const kinds = new Map<string, Set<string>>();
    const unknownTemplates: string[] = [];
    const pendingTemplates = new Set<string>();
    const add = (kind: string, file: SourceFile) => {
        if (!kind.includes('.') || kind.endsWith('.') || NOT_ACTION_KINDS.has(kind)) return;
        const set = kinds.get(kind) ?? new Set<string>();
        set.add(file.rel);
        kinds.set(kind, set);
    };
    const addName = (name: string, file: SourceFile) => {
        for (const value of resolveName(file, name)) add(value, file);
    };
    for (const file of FILES) {
        if (file.rel.startsWith('core/') || file.rel.startsWith('shared/') || file.rel.startsWith('domain/')) continue;
        // Every feature file (actions are often built in helpers far from the decide/record call), plus any other
        // file that calls the APIs.
        if (!file.rel.startsWith('features/') && !CALLS.test(file.text)) continue;
        for (const match of file.text.matchAll(/\bkind:\s*'([^']+)'/g)) add(match[1]!, file);
        for (const match of file.text.matchAll(/\bkind:\s*([A-Z][A-Z0-9_]*)\b/g)) {
            // Background task kinds (`kind: EXTRACT_TASK`) and signal kinds are not actions.
            if (!/_(TASK|SIGNAL)$/.test(match[1]!)) addName(match[1]!, file);
        }
        for (const match of file.text.matchAll(
            /(?:registerApplier|neverAuto|setLevel)\(\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*))/g,
        )) {
            if (match[1]) add(match[1], file);
            else addName(match[2]!, file);
        }
        // Action kind constants passed around (`this.decide(FIX_KIND, …)`, `record(PICK_KIND, …)`, kind lists).
        for (const match of file.text.matchAll(/\b([A-Z][A-Z0-9_]*_KINDS?)\b/g)) {
            if (!/(DOC|FILE|STATS)_KIND$/.test(match[1]!)) addName(match[1]!, file);
        }
        for (const match of file.text.matchAll(/\bkind:\s*`([^`]*)`/g)) {
            const pattern = match[1]!.replace(/\$\{[^}]*\}/g, '*');
            const known = TEMPLATES[pattern];
            if (known === undefined) unknownTemplates.push(`${pattern} (${file.rel})`);
            else if (known === 'pending') pendingTemplates.add(file.rel);
            else if (Array.isArray(known)) for (const kind of known) add(kind, file);
        }
    }
    return { kinds, unknownTemplates, pendingTemplates };
}

/** Undo targets: the first argument of journal.registerUndo, resolved. */
function scanTargets(): Map<string, Set<string>> {
    const targets = new Map<string, Set<string>>();
    for (const file of FILES) {
        if (file.rel.startsWith('core/')) continue;
        for (const match of file.text.matchAll(/registerUndo\(\s*(?:'([^']+)'|([A-Z][A-Z0-9_]*)(?:\.(\w+))?)/g)) {
            let values: string[];
            if (match[1]) values = [match[1]];
            else if (match[3]) {
                // TARGETS.canon → that entry of the object constant (here or in the imported file).
                const holder = file.constants.has(match[2]!) ? file : BY_PATH.get(file.imports.get(match[2]!) ?? '');
                const body = holder
                    ? (new RegExp(`${match[2]!}\\s*=\\s*\\{([\\s\\S]*?)\\}`).exec(holder.text)?.[1] ?? '')
                    : '';
                const entry = new RegExp(`\\b${match[3]}:\\s*'([^']+)'`).exec(body)?.[1];
                values = entry ? [entry] : [];
            } else values = resolveName(file, match[2]!);
            for (const value of values) {
                const set = targets.get(value) ?? new Set<string>();
                set.add(file.rel);
                targets.set(value, set);
            }
        }
    }
    return targets;
}

function strings(): { en: Record<string, string>; ru: Record<string, string> } {
    const en: Record<string, string> = { ...CORE_STRINGS.en, ...UI_STRINGS.en };
    const ru: Record<string, string> = { ...CORE_STRINGS.ru, ...UI_STRINGS.ru };
    for (const module of MODULES) {
        Object.assign(en, module.i18n?.en ?? {});
        Object.assign(ru, module.i18n?.ru ?? {});
    }
    return { en, ru };
}

const pending = (files: Set<string>) => [...files].every((rel) => PENDING_FOLDERS.includes(folderOf(rel)));

describe('labels of action kinds and journal targets (plan-2 §3)', () => {
    const { en, ru } = strings();
    const { kinds, unknownTemplates, pendingTemplates } = scanKinds();
    const targets = scanTargets();
    const described = new Set(MODULES.flatMap((module) => (module.targets ?? []).map((spec) => spec.target)));
    const unlabelledKinds = [...kinds.entries()].filter(([kind]) => !en[`kind.${kind}`] || !ru[`kind.${kind}`]);
    const undescribedTargets = [...targets.entries()].filter(
        ([target]) => !described.has(target) && !(en[`target.${target}`] && ru[`target.${target}`]),
    );

    it('finds the kinds and targets of the modules (the scan itself works)', () => {
        expect(kinds.size).toBeGreaterThan(60);
        for (const kind of ['living.fact', 'canon.fact', 'wardrobe.outfit', 'quality.junk', 'backgrounds.pick']) {
            expect(kinds.has(kind), kind).toBe(true);
        }
        expect(targets.has('living-fact')).toBe(true);
        expect(targets.has('revision.canon')).toBe(true);
    });

    it('knows every kind template', () => {
        expect(unknownTemplates).toEqual([]);
        expect([...pendingTemplates].every((rel) => PENDING_FOLDERS.includes(folderOf(rel)))).toBe(true);
    });

    it('gives every action kind a human label in both languages', () => {
        const missing = unlabelledKinds
            .filter(([kind, files]) => !(pending(files) && PENDING_KINDS.includes(kind)))
            .map(([kind, files]) => `${kind} (${[...files].join(', ')})`);
        expect(missing).toEqual([]);
        const done = PENDING_KINDS.filter((kind) => !unlabelledKinds.some(([item]) => item === kind));
        expect(done, 'labelled now: remove from PENDING_KINDS').toEqual([]);
    });

    it('describes every journal target that can be undone', () => {
        const missing = undescribedTargets
            .filter(([target, files]) => !(pending(files) && PENDING_TARGETS.includes(target)))
            .map(([target, files]) => `${target} (${[...files].join(', ')})`);
        expect(missing).toEqual([]);
        const done = PENDING_TARGETS.filter((target) => !undescribedTargets.some(([item]) => item === target));
        expect(done, 'described now: remove from PENDING_TARGETS').toEqual([]);
    });

    it('names kinds in Russian with words, not ids', () => {
        for (const kind of kinds.keys()) {
            const label = ru[`kind.${kind}`];
            if (!label) continue;
            expect(label, kind).not.toMatch(/\bM\d+\b/);
            expect(label, kind).not.toContain(kind);
        }
    });
});
