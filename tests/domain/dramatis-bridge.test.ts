// Release 1.17, the pure parts of Maestro's bridge to Dramatis: the cast of the scene, BunnyMo's Medicine Check and
// MED/REC tags, the offscreen brief's engine line, the director's agenda twist, the Dramatis slot in the prompt audit and
// the architect's budget sources.
import { describe, expect, it } from 'vitest';
import { BUDGET_SOURCE_IDS, cleanBudgets } from '../../src/domain/architect-budget';
import { DEPENDENCE_CATEGORIES, hasDependenceTags, isMedicineCheckEntry } from '../../src/domain/bunnymo';
import type { DesCharacter } from '../../src/domain/des-tracker';
import { buildDirectorNote, pickTwist, twistKey } from '../../src/domain/director-note';
import { slotOwner } from '../../src/domain/lore-inspector';
import { formatBrief } from '../../src/domain/offscreen-prompt';
import { ownerText } from '../../src/domain/prompt-audit-ai';
import { routeOf } from '../../src/domain/prompt-audit-fix';
import {
    auditOwnerOfSlot,
    buildCapture,
    dramatisPartOf,
    DRAMATIS_SLOTS,
    sanitizeCapture,
} from '../../src/domain/prompt-audit-map';
import type { AuditFix } from '../../src/domain/prompt-audit-rules';
import { sceneCast } from '../../src/domain/scene-cast';
import type { SceneTracker } from '../../src/domain/voices-cards';

function character(name: string, extra: Partial<DesCharacter> = {}): DesCharacter {
    return { name, details: {}, stats: [], offScene: false, ...extra };
}

function tracker(characters: DesCharacter[]): SceneTracker {
    return { index: 3, snapshot: { characters, infoBox: null, quests: null } };
}

describe('sceneCast', () => {
    const entities = [
        { id: 'persona:kai', name: 'Kai', kind: 'persona', aliases: ['Кай'] },
        { id: 'character:ilva', name: 'Ilva', kind: 'character', aliases: ['Ильва'] },
        { id: 'character:bram', name: 'Bram', kind: 'character', aliases: [] },
    ];
    const resolve = (name: string) =>
        entities.find((entity) =>
            [entity.name, ...entity.aliases].some((item) => item.toLowerCase() === name.toLowerCase()),
        );

    it('names present characters as the world model knows them, once, without the persona or hidden ones', () => {
        const cast = sceneCast(
            tracker([
                character('Ильва'),
                character('Ilva'),
                character('Кай'),
                character('Bram', { offScene: true }),
                character('Stranger'),
                character('Hidden One'),
            ]),
            { persona: 'Kai', ownName: 'Кай', hidden: ['hidden one'], resolve },
        );
        expect(cast.map((member) => member.name)).toEqual(['Ilva', 'Stranger']);
        expect(cast[0]?.entity?.id).toBe('character:ilva');
        expect(cast[1]?.entity).toBeUndefined();
        expect(sceneCast(null, { persona: 'Kai', ownName: 'Kai', hidden: [], resolve })).toEqual([]);
    });

    it('leaves out a DES name that resolves to the persona', () => {
        const cast = sceneCast(tracker([character('Кай'), character('Bram')]), {
            persona: 'Kai',
            ownName: 'Kai',
            hidden: [],
            resolve,
        });
        expect(cast.map((member) => member.name)).toEqual(['Bram']);
    });
});

describe('BunnyMo Medicine Check', () => {
    const v3 = {
        comment: '💉 Master - Medicine Check',
        key: ['/^/'],
        constant: true,
        content: '<BunnymoTags:Master - Medicine Check>\n## 💊 MEDICINE CHECK — Active Behavioral Modifier',
    };

    it('is recognised by its title or wrapper when it fires on every turn', () => {
        expect(isMedicineCheckEntry(v3)).toBe(true);
        expect(isMedicineCheckEntry({ ...v3, comment: 'Renamed', constant: false })).toBe(true);
        expect(isMedicineCheckEntry({ ...v3, content: 'translated', key: ['/^/', 'лекарства'], constant: false })).toBe(
            true,
        );
        expect(isMedicineCheckEntry({ ...v3, key: ['pills'], constant: false })).toBe(false);
        expect(isMedicineCheckEntry({ comment: 'Master - Kaomoji Library', key: ['/^/'], constant: true })).toBe(false);
        expect(isMedicineCheckEntry(null)).toBe(false);
    });

    it('finds MED and REC tags in archive tags', () => {
        expect(DEPENDENCE_CATEGORIES).toEqual(['MED', 'REC']);
        expect(hasDependenceTags(['<SPECIES:HUMAN>', '<MED:SSRI>'])).toBe(true);
        expect(hasDependenceTags(['<rec:alcohol>'])).toBe(true);
        expect(hasDependenceTags(['<MEDIC:X>', '<INTJ-U>', 'MED:X'])).toBe(false);
        expect(hasDependenceTags([])).toBe(false);
    });
});

describe('offscreen brief', () => {
    it('adds what the personality engine says the character planned and how it went', () => {
        const text = formatBrief({
            name: 'Ilva',
            aliases: [],
            facts: [],
            relations: [],
            quests: [],
            earlier: [],
            engine: ['Goal: raise the garrison tax by Friday', 'Tried: bribe the clerk — failed'],
        });
        expect(text).toContain(
            'Their own plans (from the personality engine; the event follows them): Goal: raise the garrison tax by Friday; Tried: bribe the clerk — failed',
        );
        expect(
            formatBrief({ name: 'Ilva', aliases: [], facts: [], relations: [], quests: [], earlier: [] }),
        ).not.toContain('personality engine');
    });
});

describe('director', () => {
    it('turns a mature agenda into a twist and weighs it as Dramatis says', () => {
        const agenda = { kind: 'agenda' as const, text: 'Ilva sends Bram to follow the courier', weight: 5, key: '' };
        agenda.key = twistKey('agenda', agenda.text);
        const quest = {
            kind: 'quest' as const,
            text: 'Find the map',
            weight: 3,
            key: twistKey('quest', 'Find the map'),
        };
        expect(pickTwist([quest, agenda])).toBe(agenda);
        const note = buildDirectorNote({
            twist: agenda,
            reasons: ['samePlace'],
            turns: 4,
            scene: null,
            userName: 'Kai',
        });
        expect(note).toContain("a character's own plan comes to a head now: Ilva sends Bram to follow the courier");
    });
});

describe('prompt audit and the inspector', () => {
    it('gives slots `dramatis_*` to Dramatis, by part', () => {
        expect(slotOwner('dramatis_cast')).toBe('dramatis');
        expect(auditOwnerOfSlot('dramatis_cast')).toBe('dramatis');
        expect(DRAMATIS_SLOTS.dramatis_cast).toBe('cast');
        expect(dramatisPartOf('dramatis_cast')).toBe('cast');
        expect(dramatisPartOf('dramatis_scene.extra')).toBe('scene');
    });

    it('maps the cast block and keeps its owner through storage', () => {
        const value = '[Cast] Ilva — counting the takings; toward Kai: hostile.';
        const capture = buildCapture({
            at: 1,
            chatId: 'chat-1',
            type: 'normal',
            source: 'turn',
            messages: [
                { role: 'system', content: 'Main.' },
                { role: 'system', content: value },
                { role: 'user', content: 'Hi' },
            ],
            slots: [{ key: 'dramatis_cast', value, position: 1, depth: 1, role: 0 }],
            blocks: [],
            card: [],
            neighbours: [],
            lore: [],
        });
        const item = capture.items.find((entry) => entry.ref === 'slot:dramatis_cast');
        expect(item).toMatchObject({ owner: 'dramatis', module: 'cast', place: 'chat', depth: 1, message: 1 });
        expect(sanitizeCapture(JSON.parse(JSON.stringify(capture)))?.items[0]?.owner).toBe('dramatis');
        expect(ownerText(item!)).toBe('Dramatis (personality engine extension): cast');
    });

    it('never changes Dramatis’s text itself: every fix is advice', () => {
        const item = {
            ref: 'slot:dramatis_cast',
            owner: 'dramatis' as const,
            label: 'dramatis_cast',
            key: 'dramatis_cast',
            module: 'cast',
            role: 'system' as const,
            place: 'chat' as const,
            depth: 1,
            message: 1,
            text: 'x',
            chars: 1,
            neighbours: ['dramatis.cast'],
        };
        for (const kind of ['edit', 'remove', 'role', 'move', 'toggle'] as const) {
            const fix: AuditFix = { side: 'a', kind, target: item.ref, before: 'x', after: '' };
            expect(routeOf(item, fix)).toEqual({ route: 'advice', reason: 'dramatis' });
        }
    });
});

describe('architect budgets', () => {
    it('has a Dramatis source, stored like the others', () => {
        expect(BUDGET_SOURCE_IDS).toContain('dramatis');
        expect(cleanBudgets({ dramatis: 400.7 }).dramatis).toBe(400);
        expect(cleanBudgets({}).dramatis).toBe(0);
    });
});
