import { describe, expect, it } from 'vitest';
import {
    applyText,
    fixRisk,
    isRole,
    neighbourNeedles,
    patchCapture,
    routeOf,
    routeScopes,
} from '../../src/domain/prompt-audit-fix';
import type { AuditFix } from '../../src/domain/prompt-audit-rules';
import { item, realCaseCapture } from '../helpers/prompt-audit-fixtures';

const edit: AuditFix = { side: 'a', kind: 'edit', target: 'x', before: 'a', after: 'b' };

describe('routes', () => {
    it('sends each owner where its text lives', () => {
        expect(routeOf(item({ ref: 'preset:t', owner: 'preset', key: 't', text: 'x' }), edit)).toEqual({
            route: 'preset',
            identifier: 't',
        });
        expect(routeOf(item({ ref: 'slot:d', owner: 'des', neighbours: ['des.tracker'], text: 'x' }), edit)).toEqual({
            route: 'neighbour',
            candidates: ['des.tracker'],
        });
        expect(
            routeOf(item({ ref: 'slot:d', owner: 'des', neighbours: ['des.tracker'], text: 'x' }), {
                ...edit,
                kind: 'role',
                role: 'user',
            }),
        ).toEqual({ route: 'advice', reason: 'neighbourSetting' });
        expect(routeOf(item({ ref: 'slot:o', owner: 'other', text: 'x' }), edit)).toEqual({
            route: 'advice',
            reason: 'other',
        });
        expect(routeOf(item({ ref: 'lore:B#1', owner: 'bunnymo', text: 'x' }), edit)).toEqual({
            route: 'advice',
            reason: 'bunnymo',
        });
        expect(routeOf(item({ ref: 'lore:W#1', owner: 'lore', text: 'x' }), edit)).toEqual({
            route: 'advice',
            reason: 'lore',
        });
        expect(routeOf(item({ ref: 'card:system', owner: 'card', text: 'x' }), edit)).toEqual({
            route: 'advice',
            reason: 'card',
        });
        expect(routeOf(item({ ref: 'slot:2_floating_prompt', owner: 'authorsNote', text: 'x' }), edit)).toEqual({
            route: 'advice',
            reason: 'authorsNote',
        });
        expect(routeOf(undefined, edit)).toEqual({ route: 'advice', reason: 'missing' });
        expect(routeOf(item({ ref: 'preset:x', owner: 'preset', text: 'x' }), edit)).toEqual({
            route: 'advice',
            reason: 'missing',
        });
    });

    it('switches Maestro’s own lines off through their module settings, the rest is advice', () => {
        const wardrobe = item({ ref: 'slot:maestro_wardrobe', owner: 'maestro', module: 'wardrobe', text: 'x' });
        expect(routeOf(wardrobe, { side: 'a', kind: 'toggle', target: 'x', enabled: false })).toEqual({
            route: 'maestro',
            module: 'wardrobe',
            path: 'promptLine',
            value: false,
        });
        expect(routeOf(wardrobe, { side: 'a', kind: 'move', target: 'x', depth: 3 })).toEqual({
            route: 'maestro',
            module: 'wardrobe',
            path: 'promptDepth',
            value: 3,
        });
        const director = item({ ref: 'slot:maestro_director', owner: 'maestro', module: 'director', text: 'x' });
        expect(routeOf(director, { side: 'a', kind: 'toggle', target: 'x' })).toEqual({
            route: 'advice',
            reason: 'maestro',
        });
    });

    it('never proposes a system role inside the history on a model that glues such messages', () => {
        const inChat = item({ ref: 'preset:n', owner: 'preset', key: 'n', place: 'chat', role: 'user', text: 'x' });
        const toSystem: AuditFix = { side: 'a', kind: 'role', target: 'preset:n', role: 'system' };
        expect(fixRisk(toSystem, inChat, ['systemMerge'])).toBe('systemMerge');
        expect(routeOf(inChat, toSystem, ['systemMerge'])).toEqual({ route: 'advice', reason: 'risky' });
        expect(routeOf(inChat, toSystem, [])).toEqual({ route: 'preset', identifier: 'n' });
        expect(fixRisk({ ...toSystem, role: 'assistant' }, inChat, ['assistantDepth'])).toBe('assistantDepth');
        expect(fixRisk({ ...toSystem, role: 'user' }, inChat, ['systemMerge'])).toBeNull();
        expect(fixRisk(edit, inChat, ['systemMerge'])).toBeNull();
    });

    it('knows the scopes of each route', () => {
        expect(routeScopes({ route: 'preset', identifier: 'x' })).toEqual(['global', 'character', 'chat']);
        expect(routeScopes({ route: 'maestro', module: 'm', path: 'p', value: false })).toEqual(['global']);
        expect(routeScopes({ route: 'advice', reason: 'card' })).toEqual([]);
    });
});

describe('texts', () => {
    it('replaces and removes sentences with their spare space', () => {
        expect(applyText('One. Two. Three.', 'Two.', 'Deux.')).toBe('One. Deux. Three.');
        expect(applyText('One. Two. Three.', 'Two.', '')).toBe('One. Three.');
        expect(applyText('Line one.\nRemove me.\nLine three.', 'Remove me.', '')).toBe('Line one.\nLine three.');
        expect(applyText('Keep.\nRemove me.', 'Remove me.', '')).toBe('Keep.');
        expect(applyText('Start here then go.', 'Start here', '')).toBe('then go.');
        expect(applyText('Say it , please', 'it', '')).toBe('Say , please');
        expect(applyText('abc', 'x', 'y')).toBeNull();
        expect(applyText('abc', '', 'y')).toBeNull();
    });

    it('finds a DES text that keeps {userName} where the prompt has the name', () => {
        expect(neighbourNeedles('Never speak for Bob.', 'Bob')).toEqual([
            'Never speak for Bob.',
            'Never speak for {userName}.',
        ]);
        expect(neighbourNeedles('No name.', 'Bob')).toEqual(['No name.']);
        expect(isRole('user')).toBe(true);
        expect(isRole('narrator')).toBe(false);
    });

    it('patches the capture so a re-check sees the fix', () => {
        const capture = realCaseCapture();
        patchCapture(capture, {
            side: 'a',
            kind: 'edit',
            target: 'preset:task',
            before: 'one line, no more than 150 words',
            after: 'up to 400 words',
        });
        expect(capture.items[0]!.text).toContain('Keep it short: up to 400 words.');
        patchCapture(capture, { side: 'a', kind: 'toggle', target: 'preset:world', enabled: false });
        expect(capture.items.some((entry) => entry.ref === 'preset:world')).toBe(false);
        expect(capture.messages[0]!.refs).toEqual(['preset:task', 'preset:format']);
        patchCapture(capture, { side: 'a', kind: 'role', target: 'slot:nai_studio_markers', role: 'user' });
        expect(capture.messages[5]!.role).toBe('user');
        patchCapture(capture, { side: 'a', kind: 'move', target: 'slot:nai_studio_markers', depth: 3 });
        expect(capture.items.find((entry) => entry.ref === 'slot:nai_studio_markers')!.depth).toBe(3);
        expect(patchCapture(capture, { ...edit, target: 'nope' })).toBe(capture);
    });
});
