// What the play surfaces show (plan-2 §6.А) and the constructor's helpers (plan-2 §6 п.8): values in their views,
// change meanings, durations, files and copies, the texts waiting for their English, kind changes.
import { describe, expect, it } from 'vitest';
import type { AttributeDef, MechanicDef } from '../../src/domain/mechanics-defs';
import {
    applyTranslation,
    boundsOf,
    changeKind,
    changeMeaning,
    duplicateMechanic,
    durationOf,
    durationParts,
    eventsKeptFor,
    exportFileName,
    exportMechanic,
    formatNumber,
    hasCyrillic,
    idFromName,
    importMechanic,
    interimEnglish,
    listDelta,
    MECHANIC_FILE_KIND,
    plainValue,
    sameWords,
    shareOf,
    shownValue,
    sourceHash,
    staleSources,
    timeAmount,
    translationItems,
} from '../../src/domain/mechanics-view';

const hp: AttributeDef = { id: 'hp', name: 'Здоровье', promptName: 'Health', kind: 'number', min: 0, max: 100 };
const coins: AttributeDef = { id: 'coins', name: 'Монеты', promptName: 'Coins', kind: 'number', min: 0 };
const mood: AttributeDef = {
    id: 'mood',
    name: 'Настроение',
    promptName: 'Mood',
    kind: 'scale',
    levels: ['sad', 'calm', 'happy'],
};
const tags: AttributeDef = { id: 'tags', name: 'Метки', promptName: 'Tags', kind: 'list', options: ['a', 'b'] };

function def(extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'vitals',
        name: 'Жизнь',
        promptName: 'Life',
        summary: '',
        rules: '',
        attributes: [hp, coins],
        holders: { kind: 'characters' },
        checks: [{ id: 'spell', name: 'Spell', promptName: 'Spell', dice: '1d20', difficulty: 10, triggers: [] }],
        tracking: 'manual',
        scope: { kind: 'card', avatar: 'kai.png' },
        ...extra,
    };
}

describe('values', () => {
    it('formats numbers, bounds and shares', () => {
        expect(formatNumber(12)).toBe('12');
        expect(formatNumber(12.345)).toBe('12.3');
        expect(formatNumber(Number.NaN)).toBe('—');
        expect(boundsOf(hp)).toEqual({ min: 0, max: 100 });
        expect(boundsOf(coins)).toBeNull();
        expect(boundsOf(mood)).toBeNull();
        expect(boundsOf({ kind: 'number', min: 5, max: 5 })).toBeNull();
        expect(shareOf(150, 0, 100)).toBe(1);
        expect(shareOf(-1, 0, 100)).toBe(0);
        expect(shareOf(1, 1, 1)).toBe(0);
        expect(plainValue(['a', 'b'])).toBe('a, b');
        expect(plainValue(null)).toBe('');
        expect(plainValue(2.25)).toBe('2.3');
        expect(plainValue('x')).toBe('x');
    });

    it('shows a value in each view, never in «hidden»', () => {
        expect(shownValue(hp, { view: 'bar' }, 65)).toMatchObject({ view: 'bar', text: '65/100', share: 0.65 });
        expect(shownValue(coins, { view: 'bar' }, 7)).toMatchObject({ view: 'number', text: '7' });
        expect(shownValue(hp, { view: 'number' }, '40')).toMatchObject({ view: 'number', value: 40 });
        expect(shownValue(hp, { view: 'words' }, 10)).toMatchObject({ view: 'words', words: { band: 1 } });
        expect(shownValue(coins, { view: 'words' }, 10)).toBeNull();
        expect(shownValue(hp, { view: 'icon' }, 10)).toMatchObject({ view: 'icon', share: 0.1 });
        expect(shownValue(hp, { view: 'hidden' }, 10)).toBeNull();
        expect(shownValue(hp, { view: 'number' }, null)).toBeNull();
        expect(shownValue(hp, { view: 'number' }, 'many')).toBeNull();
        expect(shownValue(mood, { view: 'words' }, 'calm')).toMatchObject({ view: 'words', words: { label: 'calm' } });
        expect(shownValue(tags, { view: 'icon' }, ['a'])).toMatchObject({ view: 'icon', text: 'a' });
        expect(shownValue(tags, { view: 'number' }, ['a', 'b'])).toMatchObject({ view: 'number', text: 'a, b' });
        expect(shownValue(tags, { view: 'words' }, [])).toBeNull();
    });

    it('compares words by band or by display', () => {
        expect(sameWords({ label: 'low', band: 2 }, { label: 'low', band: 2 })).toBe(true);
        expect(sameWords({ label: 'low', band: 2 }, { label: 'low', band: 3 })).toBe(false);
        expect(sameWords({ label: 'x', display: 'ранен' }, { label: 'y', display: 'ранен' })).toBe(true);
        expect(sameWords(null, null)).toBe(true);
        expect(sameWords(null, { label: 'x' })).toBe(false);
    });
});

describe('changes', () => {
    it('finds what a list gained and lost', () => {
        expect(listDelta(['a', 'b'], ['B', 'c'])).toEqual({ added: ['c'], removed: ['a'] });
        expect(listDelta('a, b', null)).toEqual({ added: [], removed: ['a', 'b'] });
    });

    it('tells statuses, items, reveals and the fight apart', () => {
        expect(changeMeaning({ kind: 'status', from: null, to: 'Отравлен', status: { name: 'Отравлен' } })).toEqual({
            kind: 'statusOn',
            name: 'Отравлен',
        });
        expect(changeMeaning({ kind: 'status', from: 'Отравлен', to: '' })).toEqual({
            kind: 'statusOff',
            name: 'Отравлен',
        });
        expect(changeMeaning({ kind: 'status', from: 3, to: 2 })).toEqual({ kind: 'statusTick' });
        expect(changeMeaning({ kind: 'status', from: 'Отравлен', to: 2 })).toEqual({ kind: 'statusTick' });
        expect(changeMeaning({ kind: 'item', from: 0, to: 2, item: { name: 'нож' } })).toEqual({
            kind: 'itemGained',
            name: 'нож',
            qty: 2,
        });
        expect(changeMeaning({ kind: 'item', from: 3, to: 1, item: { name: 'нож' } })).toEqual({
            kind: 'itemLost',
            name: 'нож',
            qty: 2,
        });
        expect(changeMeaning({ kind: 'item', from: '', to: 'hand', item: { name: 'нож' } })).toEqual({
            kind: 'itemEquipped',
            name: 'нож',
            slot: 'hand',
        });
        expect(changeMeaning({ kind: 'item', from: 'hand', to: '' })).toEqual({ kind: 'itemUnequipped', name: '' });
        expect(changeMeaning({ kind: 'reveal', from: 'hidden', to: 'shown' })).toEqual({ kind: 'reveal', shown: true });
        expect(changeMeaning({ kind: 'combat', from: 'off', to: 'round 1' })).toEqual({ kind: 'combatStart' });
        expect(changeMeaning({ kind: 'combat', from: 'round 2', to: 'off' })).toEqual({ kind: 'combatEnd' });
        expect(changeMeaning({ kind: 'combat', from: 'round 2', to: 'round 3' })).toEqual({
            kind: 'combatRound',
            round: 3,
        });
        expect(changeMeaning({ kind: 'combat', from: 'round 2', to: 'round 2' })).toEqual({ kind: 'combatJoin' });
        expect(changeMeaning({ from: 1, to: 2 })).toEqual({ kind: 'value' });
    });
});

describe('durations', () => {
    it('splits what is left into parts', () => {
        expect(timeAmount(30)).toEqual({ unit: 'minute', count: 30 });
        expect(timeAmount(0)).toEqual({ unit: 'minute', count: 1 });
        expect(timeAmount(180)).toEqual({ unit: 'hour', count: 3 });
        expect(timeAmount(3 * 1440)).toEqual({ unit: 'day', count: 3 });
        expect(timeAmount(21 * 1440)).toEqual({ unit: 'week', count: 3 });
        expect(durationParts({ turns: 2.4 }, null)).toEqual({ turns: 2 });
        expect(durationParts({ minutes: 120 })).toEqual({ time: { unit: 'hour', count: 2 } });
        expect(durationParts(null, { day: 5, minutes: 1110 })).toEqual({ until: { day: 5, time: '18:30' } });
        expect(durationParts(null, { day: 5 })).toEqual({ until: { day: 5 } });
        expect(durationParts(null, null)).toBeNull();
        expect(durationOf(3, undefined)).toEqual({ turns: 3 });
        expect(durationOf(undefined, 1.5)).toEqual({ minutes: 90 });
        expect(durationOf(0, Number.NaN)).toBeNull();
    });
});

describe('files and copies', () => {
    it('exports a portable definition and imports it with a fresh id and the given scope', () => {
        const file = exportMechanic({ ...def(), book: 'B', uid: 3, updatedAt: 9 });
        expect(file.kind).toBe(MECHANIC_FILE_KIND);
        expect(file.mechanic).not.toHaveProperty('book');
        expect(file.mechanic).not.toHaveProperty('uid');
        expect(file.mechanic.scope).toEqual({ kind: 'global' });
        expect(exportFileName({ id: 'vi tals' })).toBe('maestro-mechanic-vi_tals.json');
        expect(exportFileName({ id: '' })).toBe('maestro-mechanic-mechanic.json');

        const back = importMechanic(JSON.stringify(file), ['vitals'], { kind: 'chat', chatId: 'c' });
        expect(back.ok && back.def.id).toBe('zhizn');
        expect(back.ok && back.def.scope).toEqual({ kind: 'chat', chatId: 'c' });
        expect(back.ok && back.def.attributes).toEqual(def().attributes);
        const bare = importMechanic(JSON.stringify(def()), [], { kind: 'global' });
        expect(bare.ok && bare.def.id).toBe('vitals');
        expect(importMechanic('{', [], { kind: 'global' })).toEqual({ ok: false, error: 'json' });
        expect(importMechanic('[1]', [], { kind: 'global' })).toEqual({ ok: false, error: 'definition' });
        expect(importMechanic('{"kind":"x"}', [], { kind: 'global' })).toEqual({ ok: false, error: 'kind' });
        expect(importMechanic('{"name":"x"}', [], { kind: 'global' })).toEqual({ ok: false, error: 'definition' });
    });

    it('copies under a new name and makes ids from names', () => {
        const copy = duplicateMechanic({ ...def(), book: 'B', uid: 1 }, 'Жизнь 2', ['vitals']);
        expect(copy).toMatchObject({ id: 'zhizn_2', name: 'Жизнь 2' });
        expect(copy).not.toHaveProperty('uid');
        expect(idFromName('Кровь', 'attr', ['krov'])).toBe('krov_2');
        expect(idFromName('', 'attr', [])).toBe('attr');
    });
});

describe('the English for the model', () => {
    it('finds changed sources and names still in the user’s language', () => {
        expect(hasCyrillic('Мана')).toBe(true);
        expect(hasCyrillic('Mana')).toBe(false);
        expect(hasCyrillic(undefined)).toBe(false);
        expect(sourceHash(' a\r\n')).toBe(sourceHash('a'));
        const draft = def({
            name: 'Жизнь',
            promptName: undefined,
            summarySource: 'Здоровье',
            rulesSource: 'Раны',
            translatedFrom: { summary: sourceHash('Здоровье') },
            attributes: [
                { ...hp, promptName: 'Здоровье' },
                { ...coins, name: 'Монеты', promptName: 'Coins' },
                { ...hp, id: 'des', name: 'Сила', promptName: '', tracking: 'desStats' },
            ],
            checks: [{ id: 'spell', name: 'Чары', promptName: '', dice: '1d20', difficulty: 10, triggers: [] }],
            statuses: [{ name: 'Отравлен' }, { name: 'Bless', promptName: 'blessed' }],
        });
        expect(staleSources(draft)).toEqual(['rules']);
        expect(translationItems(draft)).toEqual([
            { key: 'rules', text: 'Раны' },
            { key: 'name', text: 'Жизнь' },
            { key: 'attr.hp', text: 'Здоровье' },
            { key: 'check.spell', text: 'Чары' },
            { key: 'status.0', text: 'Отравлен' },
        ]);
        const asked = translationItems(draft);
        const done = applyTranslation(draft, asked, [
            { key: 'rules', text: 'Wounds' },
            { key: 'name', text: 'Life' },
            { key: 'attr.hp', text: 'Health' },
            { key: 'check.spell', text: 'Charm' },
            { key: 'status.0', text: 'poisoned' },
            { key: 'summary', text: 'ignored: not asked' },
            { key: 'attr.nope', text: 'x' },
            { key: 'status.1', text: '  ' },
        ]);
        expect(done.rules).toBe('Wounds');
        expect(done.translatedFrom).toEqual({ summary: sourceHash('Здоровье'), rules: sourceHash('Раны') });
        expect(done.promptName).toBe('Life');
        expect(done.attributes[0]?.promptName).toBe('Health');
        expect(done.checks[0]?.promptName).toBe('Charm');
        expect(done.statuses?.[0]?.promptName).toBe('poisoned');
        expect(translationItems(done)).toEqual([]);
        // The source changed while the request ran: the old answer is not laid in.
        const changed = { ...draft, rulesSource: 'Новые раны' };
        expect(applyTranslation(changed, asked, [{ key: 'rules', text: 'Wounds' }]).rules).toBe('');
    });

    it('gives the model his words while they wait for the English', () => {
        const draft = def({
            rulesSource: 'Раны',
            rules: 'Old',
            summarySource: 'Кратко',
            translatedFrom: { summary: 'x' },
        });
        const interim = interimEnglish(draft);
        expect(interim.rules).toBe('Раны');
        expect(interim.summary).toBe('Кратко');
        expect(interim).not.toHaveProperty('translatedFrom');
        const fresh = def({ rulesSource: 'Раны', rules: 'Wounds', translatedFrom: { rules: sourceHash('Раны') } });
        expect(interimEnglish(fresh).rules).toBe('Wounds');
    });
});

describe('kinds', () => {
    const events: AttributeDef['events'] = [
        { id: 'low', when: { op: '<=', value: 0 }, text: 'x' },
        { id: 'level', when: { op: '=', value: 'calm' }, text: 'y' },
        { id: 'any', when: { op: 'changed' }, text: 'z' },
    ];

    it('counts the events that fit another kind and keeps them on a switch', () => {
        expect(eventsKeptFor({ events }, 'number')).toBe(2);
        expect(eventsKeptFor({ events }, 'scale')).toBe(2);
        expect(eventsKeptFor({ events }, 'list')).toBe(2);
        expect(eventsKeptFor({}, 'text')).toBe(0);
        const switched = changeKind({ ...hp, events, formula: '@x', growth: { perUse: 1 } }, 'scale');
        expect(switched).toMatchObject({ kind: 'scale', levels: ['low', 'medium', 'high'], initial: 'medium' });
        expect(switched).not.toHaveProperty('formula');
        expect(switched.events).toHaveLength(3);
        expect(changeKind({ ...mood, events }, 'number', true)).toMatchObject({ kind: 'number', min: 0, max: 100 });
        expect(changeKind({ ...mood, events }, 'number', true)).not.toHaveProperty('events');
        expect(changeKind(hp, 'list')).toMatchObject({ kind: 'list', options: [] });
        expect(changeKind(hp, 'text')).toEqual({ id: 'hp', name: 'Здоровье', promptName: 'Health', kind: 'text' });
    });
});
