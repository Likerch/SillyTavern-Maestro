import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTRY_TYPES, ENTRY_TYPE_IDS } from '../../../../src/domain/entry-types';
import {
    GENERATION_TRIGGERS,
    LOGIC_ORDER,
    MATCH_FLAGS,
    POSITION_OPTIONS,
} from '../../../../src/domain/lore-form-fields';
import { ENTRY_FORM_STRINGS } from '../../../../src/features/loreStudio/form';

const SOURCE = join(__dirname, '../../../../src/features/loreStudio/form');

describe('entry form strings', () => {
    it('have the same non-empty keys in English and Russian', () => {
        expect(Object.keys(ENTRY_FORM_STRINGS.ru).sort()).toEqual(Object.keys(ENTRY_FORM_STRINGS.en).sort());
        for (const [key, text] of Object.entries(ENTRY_FORM_STRINGS.ru)) expect(text, key).not.toBe('');
        for (const key of Object.keys(ENTRY_FORM_STRINGS.en)) expect(key.startsWith('m23f.'), key).toBe(true);
    });

    it('cover every literal key used by the form', () => {
        const used = new Set<string>();
        for (const file of readdirSync(SOURCE).filter((name) => name.endsWith('.ts') && name !== 'strings.ts')) {
            const source = readFileSync(join(SOURCE, file), 'utf8');
            for (const match of source.matchAll(/'(m23f\.[A-Za-z0-9_.]+)'/g)) used.add(match[1]!);
        }
        expect(used.size).toBeGreaterThan(200);
        const missing = [...used].filter((key) => !(key in ENTRY_FORM_STRINGS.en));
        expect(missing).toEqual([]);
    });

    it('cover every key built at runtime', () => {
        const dynamic = [
            ...POSITION_OPTIONS.map((option) => `m23f.pos.${option.name}`),
            ...LOGIC_ORDER.map((value) => `m23f.logic.${value}`),
            ...['constant', 'normal', 'vectorized'].map((state) => `m23f.state.${state}`),
            ...GENERATION_TRIGGERS.map((trigger) => `m23f.trigger.${trigger}`),
            ...MATCH_FLAGS.map((flag) => `m23f.src.${flag}`),
            ...ENTRY_TYPE_IDS.map((type) => `m23f.type.${type}`),
            ...ENTRY_TYPE_IDS.flatMap((type) => ENTRY_TYPES[type].fields.map((field) => `m23f.tf.${field.id}`)),
            ...['notNumber', 'required', 'negative', 'notInteger'].map((error) => `m23f.num.${error}`),
            ...['badRegex', 'comma', 'macroBrace', 'macro', 'cyrillicWholeWord', 'duplicate'].map(
                (issue) => `m23f.keys.issue.${issue}`,
            ),
            ...['disabled', 'dontActivate', 'activateDecorator', 'constant', 'noKeys', 'noPrimary', 'activated'].map(
                (outcome) => `m23f.test.outcome.${outcome}`,
            ),
            ...['error', 'warn', 'info'].map((severity) => `m23f.doctor.sev.${severity}`),
            ...['user', 'localizer', 'ck', 'st'].map((by) => `m23f.hist.by.${by}`),
            ...['override', 'addition', 'suppress', 'pin'].map((kind) => `m23f.canon.kind.${kind}`),
            ...['active', 'provisional', 'archived'].map((status) => `m23f.canon.status.${status}`),
            ...['user', 'revision', 'living', 'chronicle', 'backstage', 'entity', 'import'].map(
                (origin) => `m23f.canon.origin.${origin}`,
            ),
            ...[
                'bunnymo.core',
                'bunnymo.pack',
                'ck.archive',
                'world',
                'card',
                'npc',
                'canon',
                'maestro',
                'chat',
                'persona',
                'backup',
                'unknown',
            ].map((value) => `m23f.role.${value}`),
        ];
        expect(dynamic.filter((key) => !(key in ENTRY_FORM_STRINGS.en))).toEqual([]);
    });
});
