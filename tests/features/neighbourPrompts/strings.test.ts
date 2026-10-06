import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEIGHBOUR_STRINGS } from '../../../src/features/neighbourPrompts/strings';
import { createDescriptors, MAESTRO_INJECTIONS } from '../../../src/features/neighbourPrompts/descriptors';
import { LAYER_STRINGS } from '../../../src/features/presetStudio/layer-strings';
import { SCOPE_STRINGS } from '../../../src/features/presetStudio/scope-strings';
import type { App, I18nParts } from '../../../src/shared/contracts';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

function parity(name: string, parts: I18nParts): void {
    it(`${name}: the same non-empty keys and placeholders in English and Russian`, () => {
        expect(Object.keys(parts.ru).sort()).toEqual(Object.keys(parts.en).sort());
        for (const [key, text] of Object.entries(parts.en)) {
            expect(parts.ru[key], key).toBeTruthy();
            expect(placeholders(parts.ru[key] ?? ''), key).toEqual(placeholders(text));
        }
    });
}

describe('strings of release 1.13', () => {
    parity('neighbour prompts', NEIGHBOUR_STRINGS);
    parity('scopes, bindings, the neighbours tab', SCOPE_STRINGS);
    parity('the layer', LAYER_STRINGS);

    it('name and describe every entry of the registry', () => {
        const app = { adapters: {}, settings: { isModuleEnabled: () => false } } as unknown as App;
        const ids = createDescriptors(app).map((descriptor) => descriptor.id);
        expect(ids).toHaveLength(14 + MAESTRO_INJECTIONS.length);
        for (const id of ids) {
            expect(NEIGHBOUR_STRINGS.en[`m36.p.${id}.label`], id).toBeTruthy();
            expect(NEIGHBOUR_STRINGS.ru[`m36.p.${id}.description`], id).toBeTruthy();
        }
    });

    it('cover every literal key of the module', () => {
        const dir = join(__dirname, '../../../src/features/neighbourPrompts');
        const used = new Set<string>();
        for (const file of ['service.ts', 'descriptors.ts', 'index.ts']) {
            for (const match of readFileSync(join(dir, file), 'utf8').matchAll(/'(m36\.[A-Za-z0-9_.-]+)'/g)) {
                used.add(match[1]!);
            }
        }
        const dynamic = ['character', 'chat'].flatMap((scope) => [
            `m36.journal.copy.${scope}`,
            `m36.journal.copyRemoved.${scope}`,
        ]);
        expect([...used, ...dynamic].filter((key) => !(key in NEIGHBOUR_STRINGS.en))).toEqual([]);
    });

    it('the layer’s dynamic keys exist', () => {
        const keys = [
            ...['global', 'character', 'chat'].map((scope) => `m34.layerSvc.journal.moveScope.${scope}`),
            ...['character', 'chat'].flatMap((scope) => [
                `m34.layerSvc.journal.bind.${scope}`,
                `m34.layerSvc.journal.unbind.${scope}`,
                `m34.binding.done.${scope}`,
                `m34.binding.removed.${scope}`,
                `m34.binding.reason.${scope}`,
            ]),
            ...['global', 'character', 'chat'].flatMap((scope) => [
                `m34.scope.${scope === 'character' ? 'character' : scope}`,
                `m34.neighbours.scope.${scope}`,
                `m34.neighbours.saved.${scope}`,
                `m34.neighbours.resetBody.${scope}`,
                `m34.neighbours.reset.${scope}`,
            ]),
            ...['des', 'nai', 'qvink', 'desru', 'ck', 'maestro'].map((owner) => `m34.neighbours.owner.${owner}`),
            ...['unknown', 'readOnly', 'absent', 'busy', 'notScopable', 'noScope'].map(
                (code) => `m34.neighbours.error.${code}`,
            ),
        ];
        const all = { ...LAYER_STRINGS.en, ...SCOPE_STRINGS.en };
        expect(keys.filter((key) => !(key in all))).toEqual([]);
    });
});
