// Release 1.26, the pure parts of tracking that keeps up: 'auto' as the default mode, the «nothing changed» block and
// the block's story time, the block instruction for 'auto' attributes, the smarter background parse (the player's
// action, who «you» is, the rules in full, the elapsed time), the clock moved by minutes without DES, a turn of story
// time only, and messages deleted from the middle of the chat.
import { describe, expect, it } from 'vitest';
import {
    blockInstruction,
    isNoneLine,
    parseBlock,
    parseElapsedText,
    parseTimeLine,
    resolveBlock,
    stripBlock,
} from '../../src/domain/mechanics-block';
import {
    desStatCandidates,
    desStatsAttributes,
    normalizeDef,
    TRACKING_MODES,
    trackingOf,
} from '../../src/domain/mechanics-defs';
import type { AttributeDef, MechanicDef } from '../../src/domain/mechanics-defs';
import {
    buildExtractMessages,
    EXTRACT_LIMITS,
    extractSchemaFor,
    parseExtractAnswer,
} from '../../src/domain/mechanics-extract';
import type { ExtractTarget } from '../../src/domain/mechanics-extract';
import { applyOps, emptyStateDoc, normalizeStateDoc, removeMessages } from '../../src/domain/mechanics-state';
import type { ChangeInputData, ClockRecord, MechanicsStateDoc, OpInput } from '../../src/domain/mechanics-state';
import { advanceByMinutes, RELATIVE_START } from '../../src/domain/mechanics-time';
import { turnOps } from '../../src/domain/mechanics-turn';

const mana: AttributeDef = {
    id: 'mana',
    name: 'Мана',
    promptName: 'Mana',
    kind: 'number',
    min: 0,
    max: 100,
    initial: 100,
};
const hp: AttributeDef = {
    id: 'hp',
    name: 'Здоровье',
    promptName: 'Health',
    kind: 'number',
    min: 0,
    max: 100,
    initial: 100,
};
const mood: AttributeDef = {
    id: 'mood',
    name: 'Настрой',
    promptName: 'Mood',
    kind: 'scale',
    levels: ['low', 'calm', 'high'],
};

function def(extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'vitals',
        name: 'Жизнь',
        summary: 'Health and mana',
        rules: 'Wounds cost health.',
        attributes: [hp, mana, mood],
        holders: { kind: 'characters', includePersona: true },
        checks: [],
        tracking: 'auto',
        scope: { kind: 'global' },
        ...extra,
    };
}

describe("'auto' tracking mode", () => {
    it('is the default of a definition without a mode; an explicit one stays', () => {
        expect(TRACKING_MODES[0]).toBe('auto');
        expect(normalizeDef({ id: 'x' })?.tracking).toBe('auto');
        expect(normalizeDef({ id: 'x', tracking: 'weird' })?.tracking).toBe('auto');
        expect(normalizeDef({ id: 'x', tracking: 'background' })?.tracking).toBe('background');
        expect(normalizeDef({ id: 'x', tracking: 'block' })?.tracking).toBe('block');
        expect(
            normalizeDef({ id: 'x', attributes: [{ id: 'a', kind: 'number', tracking: 'auto' }] })?.attributes[0],
        ).toMatchObject({ tracking: 'auto' });
    });

    it('stays auto per attribute; numbers of characters may be DES stats, derived ones and other holders not', () => {
        const vitals = def({ attributes: [hp, mana, mood, { ...mana, id: 'max', formula: '100' }] });
        expect(trackingOf(vitals, hp)).toBe('auto');
        expect(desStatsAttributes(vitals)).toEqual([]);
        expect(desStatCandidates(vitals).map((attr) => attr.id)).toEqual(['hp', 'mana']);
        expect(desStatCandidates(def({ holders: { kind: 'world' } }))).toEqual([]);
        expect(
            desStatCandidates(
                def({
                    attributes: [
                        { ...hp, tracking: 'desStats' },
                        { ...mana, tracking: 'manual' },
                    ],
                }),
            ),
        ).toEqual([{ ...hp, tracking: 'desStats' }]);
    });
});

describe('the «nothing changed» block', () => {
    const story = 'Кай кивнул.';

    it('reads none / нет / - / an empty block as found with no changes, and strips it', () => {
        for (const body of ['none', 'нет', '-', '', 'Nothing changed.', 'без изменений']) {
            const text = `${story}\n<mechanics>${body}</mechanics>`;
            const parsed = parseBlock(text);
            expect(parsed).toMatchObject({ found: true, items: [], dropped: [], none: true });
            expect(stripBlock(text)).toBe(story);
        }
        // An unclosed one too: the word belongs to the block.
        expect(stripBlock(`${story}\n<mechanics>\nnone`)).toBe(story);
        expect(parseBlock(`${story}\n<mechanics>\nnone`).none).toBe(true);
    });

    it('is not «none» when anything else is there', () => {
        expect(parseBlock('<mechanics>\nnone\nKai.Mana: -5\n</mechanics>')).toMatchObject({ none: false });
        expect(parseBlock('<mechanics>\nnone\nKai.Mana: -5\n</mechanics>').items).toHaveLength(1);
        expect(parseBlock('<mechanics>\ngibberish here\n</mechanics>')).toMatchObject({
            none: false,
            dropped: ['gibberish here'],
        });
        expect(parseBlock('<mechanics>\nroll: Stealth Kai\n</mechanics>').none).toBe(false);
        expect(parseBlock('no block here').none).toBe(false);
        expect(isNoneLine('**none**')).toBe(true);
        expect(isNoneLine('Kai.none = 1')).toBe(false);
    });
});

describe("the block's story time", () => {
    it('reads forward times in minutes, hours, days and weeks, English and Russian', () => {
        expect(parseElapsedText('+3h')).toBe(180);
        expect(parseElapsedText('+30m')).toBe(30);
        expect(parseElapsedText('+2d')).toBe(2880);
        expect(parseElapsedText('1h30m')).toBe(90);
        expect(parseElapsedText('+2 часа')).toBe(120);
        expect(parseElapsedText('15 минут')).toBe(15);
        expect(parseElapsedText('полчаса')).toBe(30);
        expect(parseElapsedText('1 week')).toBe(10080);
        expect(parseElapsedText('-3h')).toBeNull();
        expect(parseElapsedText('soon')).toBeNull();
        expect(parseElapsedText('0m')).toBeNull();
        expect(parseElapsedText('900d')).toBe(365 * 1440);
    });

    it('takes time lines out of the block (they add up) and keeps the rest', () => {
        expect(parseTimeLine('time: +3h')).toBe(180);
        expect(parseTimeLine('- время: +20м')).toBe(20);
        expect(parseTimeLine('Kai.Mana: -5')).toBeNull();
        const parsed = parseBlock('Story.\n<mechanics>\nKai.Mana: -5\ntime: +1h\ntime: +30m\n</mechanics>');
        expect(parsed.elapsed).toBe(90);
        expect(parsed.items.map((item) => item.line)).toEqual(['Kai.Mana: -5']);
        expect(parsed.dropped).toEqual([]);
        const alone = parseBlock('Story.\n<mechanics>\ntime: +2h\n</mechanics>');
        expect(alone).toMatchObject({ found: true, none: false, elapsed: 120, items: [] });
        expect(stripBlock('Story.\n<mechanics>\ntime: +2h')).toBe('Story.');
    });
});

describe('the block instruction for auto attributes', () => {
    it('lists auto attributes like block ones and asks for the block every time, none when nothing changed', () => {
        const text = blockInstruction([def()], { vitals: ['Kai', 'Алекс'] });
        expect(text).toContain(
            '[Mechanics block] Always end your reply, after the story, with a service block that lists every change this reply makes to the values below; when nothing changed, write <mechanics>none</mechanics>:',
        );
        expect(text).not.toContain('leave the block out');
        expect(text).toContain('Holders: Kai, Алекс');
        expect(text).toContain('- Health: number 0-100');
        expect(text).toContain('- Mood: scale low < calm < high');
        expect(text).not.toContain('Story time');
    });

    it("leaves out numbers DES keeps for the characters but keeps them for the user's character", () => {
        const text = blockInstruction(
            [def()],
            { vitals: ['Kai', 'Алекс'] },
            {
                desTracked: (_def, attr) => attr.id === 'hp',
                persona: { name: 'Алекс', attributes: (item) => item.attributes.filter((attr) => attr.id === 'hp') },
            },
        );
        const groups = text.split('Holders: ').slice(1);
        expect(groups[0]).not.toContain('Health');
        expect(groups[0]).toContain('Mana');
        expect(groups[1]).toBe('Алекс\n- Health: number 0-100');
    });

    it('asks for the story time only when told, statuses of auto mechanics go through the block', () => {
        const text = blockInstruction([def({ statuses: [] })], { vitals: ['Kai'] }, { time: true });
        expect(text).toContain(
            'Story time: add time: +30m (or +3h, +2d) for the story time that passes in this reply.',
        );
        expect(text).toContain('Conditions: Holder.status += Poisoned (3 turns)');
        // Time alone makes no block (the background parse says how long a reply took then).
        expect(blockInstruction([def({ tracking: 'background' })], { vitals: ['Kai'] }, { time: true })).toBe('');
        // Rolls only: the short form, no «always».
        const rolls = blockInstruction([def({ tracking: 'manual' })], { vitals: ['Kai'] }, { checks: ['Stealth'] });
        expect(rolls).toContain('When the story needs it');
        expect(rolls).not.toContain('Always end');
    });

    it('applies auto lines by default', () => {
        const resolved = resolveBlock(
            [{ holder: 'Kai', attribute: 'Mana', op: 'add', value: -5, line: 'Kai.Mana: -5' }],
            [def()],
            { resolveHolder: (_def, raw) => raw },
        );
        expect(resolved.edits).toEqual([
            { mechanicId: 'vitals', holder: 'Kai', attribute: 'mana', op: 'add', value: -5 },
        ]);
    });
});

describe('the background parse, 1.26', () => {
    const longRules = `${'A sword wound costs 10 to 20 health. '.repeat(40)}END-OF-RULES`;
    const target: ExtractTarget = {
        def: def({ rules: longRules }),
        attributes: [hp, mana],
        holders: [{ name: 'Kai', values: { hp: 80, mana: 50 } }],
    };

    it('gets the action, who «you» is, the rules in full and is told to apply them', () => {
        const [system, user] = buildExtractMessages({
            targets: [target],
            reply: 'Клинок задел Кая.',
            action: 'Я бью Кая мечом.',
            persona: 'Алекс',
        });
        expect(system?.content).toContain('<action>');
        expect(system?.content).toContain("apply each mechanic's rules");
        expect(system?.content).toContain('a sword wound costs health as the rules say');
        expect(system?.content).not.toContain('no guesses');
        expect(system?.content).not.toContain('"elapsed"');
        expect(user?.content).toContain('<action>\nЯ бью Кая мечом.\n</action>');
        expect(user?.content).toContain(
            'The player\'s character is Алекс: "you", "ты" and "вы" in the action and in the narration mean Алекс.',
        );
        expect(user?.content).toContain('END-OF-RULES');
        expect(longRules.length).toBeGreaterThan(600);
        expect(EXTRACT_LIMITS.rules).toBe(2000);
        expect(user!.content.indexOf('<action>')).toBeLessThan(user!.content.indexOf('<reply>'));
    });

    it('leaves the action out when there is none and clips a long one', () => {
        const [, bare] = buildExtractMessages({ targets: [target], reply: 'Тихо.' });
        expect(bare?.content).not.toContain('<action>');
        expect(bare?.content).not.toContain("The player's character");
        const [, long] = buildExtractMessages({ targets: [target], reply: 'Тихо.', action: 'я'.repeat(3000) });
        expect(long?.content).toContain(`${'я'.repeat(EXTRACT_LIMITS.action - 1)}…`);
    });

    it('asks for the elapsed story time only when told, and reads it', () => {
        const [system] = buildExtractMessages({ targets: [target], reply: 'Они шли весь день.', elapsed: true });
        expect(system?.content).toContain('"elapsed": the story minutes that pass within the reply');
        const schema = extractSchemaFor({ elapsed: true }) as {
            required: string[];
            properties: Record<string, unknown>;
        };
        expect(schema.required).toEqual(['changes', 'elapsed']);
        expect(schema.properties.elapsed).toMatchObject({ type: ['number', 'null'] });
        expect(parseExtractAnswer({ changes: [], elapsed: 480 }, [target])?.elapsed).toBe(480);
        expect(parseExtractAnswer({ changes: [], elapsed: null }, [target])?.elapsed).toBeNull();
        expect(parseExtractAnswer({ changes: [], elapsed: -5 }, [target])?.elapsed).toBeNull();
        expect(parseExtractAnswer({ changes: [] }, [target])?.elapsed).toBeNull();
    });
});

describe('the clock without DES', () => {
    it('starts a relative clock at day 1, 00:00 and moves it by minutes', () => {
        const first = advanceByMinutes(null, 90);
        expect(first.from).toEqual(RELATIVE_START);
        expect(first.clock).toEqual({ day: 1, minutes: 90, label: '', relative: true });
        const next = advanceByMinutes(first.clock, 1440 + 60);
        expect(next.clock).toEqual({ day: 2, minutes: 150, label: '', relative: true });
    });

    it("moves DES's clock on (its time text goes), and counts a date-only clock from its midnight", () => {
        const des = { day: 3, minutes: 1380, label: '3rd of Frost', time: '23:00', weekday: 6 };
        const moved = advanceByMinutes(des, 120);
        expect(moved.clock).toEqual({ day: 4, minutes: 60, label: '3rd of Frost', weekday: 0 });
        const dateOnly = advanceByMinutes({ day: 3, label: 'Day 3' }, 180);
        expect(dateOnly.from).toEqual({ day: 3, minutes: 0, label: 'Day 3' });
        expect(dateOnly.clock).toEqual({ day: 3, minutes: 180, label: 'Day 3', relative: true });
    });

    it('a turn of story time only: hour rules and minute statuses move, per-turn things stay', () => {
        const survival = def({
            id: 'survival',
            attributes: [
                { ...hp, id: 'hunger', promptName: 'Hunger' },
                { ...mana, id: 'focus' },
            ],
            time: [
                { attr: 'hunger', amount: 2, per: 'hour' },
                { attr: 'focus', amount: 5, per: 'turn' },
            ],
            statuses: [],
        });
        const doc: MechanicsStateDoc = emptyStateDoc();
        const getDef = (id: string) => (id === 'survival' ? survival : null);
        applyOps(
            doc,
            [
                {
                    kind: 'status',
                    op: 'add',
                    mechanicId: 'survival',
                    holder: 'Kai',
                    status: { name: 'Dazed', duration: { minutes: 60 } },
                    source: 'block',
                    messageIndex: 1,
                },
                {
                    kind: 'status',
                    op: 'add',
                    mechanicId: 'survival',
                    holder: 'Kai',
                    status: { name: 'Poisoned', duration: { turns: 3 } },
                    source: 'block',
                    messageIndex: 1,
                },
            ],
            { getDef, now: 1, newId: () => `s${Math.random()}` },
        );
        const moved = advanceByMinutes(doc.clock, 180);
        const { ops, step } = turnOps(
            doc,
            {
                index: 3,
                clock: moved.clock as ClockRecord,
                from: moved.from as ClockRecord,
                turns: 0,
                defs: [survival],
                holdersOf: () => ['Kai'],
            },
            getDef,
        );
        expect(step).toEqual({ turns: 0, minutes: 180, hours: 3, days: 0 });
        const values = ops.filter((op): op is ChangeInputData => op.kind === undefined || op.kind === 'value');
        expect(values.map((op) => [op.attribute, op.value])).toEqual([['hunger', 6]]);
        const statuses = ops.filter((op) => op.kind === 'status');
        // Dazed (60 min) ran out; Poisoned (turns) does not lose a turn.
        expect(statuses).toEqual([expect.objectContaining({ op: 'remove', expired: true })]);
        expect(ops[0]).toMatchObject({ kind: 'clock', index: 3, clock: { day: 1, minutes: 180, relative: true } });
    });

    it('keeps the relative flag of a stored clock', () => {
        const doc = normalizeStateDoc({ clock: { day: 2, minutes: 30, label: '', relative: true } });
        expect(doc.clock).toEqual({ day: 2, minutes: 30, label: '', relative: true });
    });
});

describe('messages deleted from the middle', () => {
    const vitals = def({ tracking: 'block', statuses: [] });
    const getDef = (id: string) => (id === 'vitals' ? vitals : null);
    let seq = 0;
    const run = (doc: MechanicsStateDoc, ops: OpInput[]) =>
        applyOps(doc, ops, { getDef, now: 1, newId: () => `c${++seq}` });

    function story(): MechanicsStateDoc {
        const doc = emptyStateDoc();
        run(doc, [
            {
                mechanicId: 'vitals',
                holder: 'Kai',
                attribute: 'hp',
                value: -10,
                delta: true,
                source: 'block',
                messageIndex: 1,
            },
        ]);
        run(doc, [
            {
                mechanicId: 'vitals',
                holder: 'Kai',
                attribute: 'hp',
                value: -5,
                delta: true,
                source: 'block',
                messageIndex: 3,
            },
        ]);
        run(doc, [
            {
                kind: 'status',
                op: 'add',
                mechanicId: 'vitals',
                holder: 'Kai',
                status: { name: 'Bleeding', duration: { turns: 3 } },
                source: 'block',
                messageIndex: 3,
            },
        ]);
        run(doc, [
            {
                mechanicId: 'vitals',
                holder: 'Kai',
                attribute: 'mana',
                value: -20,
                delta: true,
                source: 'block',
                messageIndex: 5,
            },
        ]);
        run(doc, [
            { mechanicId: 'vitals', holder: 'Kai', attribute: 'hp', value: 77, source: 'user', messageIndex: 3 },
        ]);
        doc.clockHistory = [
            { index: 1, clock: { day: 1, label: 'a' } },
            { index: 3, clock: { day: 2, label: 'b' } },
            { index: 5, clock: { day: 3, label: 'c' } },
        ];
        doc.clock = { day: 3, label: 'c' };
        doc.lastTurn = 5;
        return doc;
    }

    it('takes back only the deleted messages and moves the later ones down', () => {
        const doc = story();
        const removed = removeMessages(doc, 2, 2, getDef);
        // Message 3's tracked changes go (hp -5 as a difference: the user's edit stays, the status ends).
        expect(removed.map((change) => change.kind ?? 'value')).toEqual(['status', 'value']);
        expect(doc.holders.vitals?.Kai?.values.hp).toBe(82);
        expect(doc.statuses.Kai ?? []).toEqual([]);
        // Message 5 is message 3 now.
        expect(doc.log.map((change) => [change.attribute, change.messageIndex, change.source])).toEqual([
            ['hp', 1, 'block'],
            ['mana', 3, 'block'],
            ['hp', 3, 'user'],
        ]);
        expect(doc.clockHistory.map((entry) => entry.index)).toEqual([1, 3]);
        expect(doc.clock).toEqual({ day: 3, label: 'c' });
        expect(doc.lastTurn).toBe(3);
        expect(doc.holders.vitals?.Kai?.updatedAt).toBe(3);
    });

    it('rewinds the clock when its newest step went with the deleted messages', () => {
        const doc = story();
        removeMessages(doc, 5, 1, getDef);
        expect(doc.clock).toEqual({ day: 2, label: 'b' });
        expect(doc.lastTurn).toBe(4);
        expect(removeMessages(doc, 0, 0, getDef)).toEqual([]);
    });

    it("moves a later status's start and keeps it once when the log shares the object", () => {
        const doc = emptyStateDoc();
        run(doc, [
            {
                kind: 'status',
                op: 'add',
                mechanicId: 'vitals',
                holder: 'Kai',
                status: { name: 'Cursed' },
                source: 'block',
                messageIndex: 6,
            },
        ]);
        removeMessages(doc, 2, 2, getDef);
        expect(doc.statuses.Kai?.[0]?.since).toBe(4);
        expect(doc.log[0]?.messageIndex).toBe(4);
        expect(doc.log[0]?.statusAfter?.since).toBe(4);
    });
});
