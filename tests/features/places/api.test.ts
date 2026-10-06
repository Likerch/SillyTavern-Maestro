import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLabels, describeChange } from '../../../src/core/labels';
import { PLACES_STRINGS, PLACES_TARGETS, placesModule } from '../../../src/features/places';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import { FakeCanon, createPlacesTestApp, settle, startModule, turn } from './helpers';
import type { PlacesTestApp } from './helpers';

let env: PlacesTestApp;
let places: Required<PlacesApi>;
let stop: () => Promise<void>;

function named(name: string): Place {
    const found = places.list().find((place) => place.name === name);
    if (!found) throw new Error(`no place ${name}`);
    return found;
}

async function undoLast(): Promise<boolean> {
    const record = env.journal.records.filter((item) => !item.undone).at(-1)!;
    const ok = await env.journal.undo(record.id);
    await settle();
    return ok;
}

beforeEach(async () => {
    env = createPlacesTestApp();
    const started = await startModule(env, placesModule);
    stop = () => started.stop();
    places = env.modules.api<Required<PlacesApi>>('places')!;
    await settle();
});

afterEach(async () => {
    await stop();
});

describe('editing places', () => {
    it('creates, renames and re-parents with journal undo', async () => {
        const city = await places.create('Port Royal');
        const inn = await places.create('Rusty Anchor', city.id);
        expect(inn).toMatchObject({ parent: city.id, firstSeen: -1, lastSeen: -1, visits: [] });
        expect(env.journal.records.at(-1)).toMatchObject({
            module: 'M24',
            kind: 'places.create',
            summary: 'New place: «Rusty Anchor»',
        });

        await places.update(inn.id, { name: 'Rusty Anchor Inn', aliases: ['Anchor'] });
        expect(named('Rusty Anchor Inn').aliases).toEqual(['Anchor', 'Rusty Anchor']);
        expect(env.journal.records.at(-1)?.summary).toBe('The place «Rusty Anchor» is now called «Rusty Anchor Inn»');
        await places.update(inn.id, { parent: null });
        expect(env.journal.records.at(-1)?.summary).toBe('Place «Rusty Anchor Inn» changed');
        expect(await undoLast()).toBe(true);
        expect(named('Rusty Anchor Inn').parent).toBe(city.id);
        expect(await undoLast()).toBe(true);
        expect(named('Rusty Anchor').aliases).toEqual([]);
        expect(await undoLast()).toBe(true);
        expect(places.list().map((place) => place.name)).toEqual(['Port Royal']);
    });

    it('shows its journal changes in words: names, other names, the parent place by name', async () => {
        expect(placesModule.targets).toBe(PLACES_TARGETS);
        const keys = [
            ...['merge', 'create', 'update', 'remove', 'alias'].map((kind) => `kind.places.${kind}`),
            ...PLACES_TARGETS.map((spec) => `target.${spec.target}`),
            ...PLACES_TARGETS.flatMap((spec) => Object.values(spec.fields ?? {}).map((field) => field.labelKey)),
        ];
        for (const key of keys) {
            expect(PLACES_STRINGS.en[key], key).toBeTruthy();
            expect(PLACES_STRINGS.ru[key], key).toBeTruthy();
        }
        const labels = createLabels();
        labels.register(PLACES_TARGETS);
        const city = await places.create('Port Royal');
        const inn = await places.create('Rusty Anchor');
        await places.update(inn.id, { parent: city.id, aliases: ['Anchor'] });
        const change = env.journal.records.at(-1)!.changes[0]!;
        expect(describeChange(change, labels, env.app.i18n)).toEqual({
            label: 'Place',
            rows: [
                { label: 'Other names', kind: 'added', after: 'Anchor' },
                { label: 'Part of', kind: 'added', after: 'Port Royal' },
            ],
        });
        expect(JSON.stringify(describeChange(change, labels, env.app.i18n))).not.toContain(inn.id);
    });

    it('reports bad edits in plain words', async () => {
        const city = await places.create('City');
        const inn = await places.create('Inn', city.id);
        await expect(places.create('  ')).rejects.toThrow('A place needs a name.');
        await expect(places.update(city.id, { parent: inn.id })).rejects.toThrow('cannot contain this one');
        await expect(places.update('nope', { name: 'X' })).rejects.toThrow('This place (or name) is gone.');
        await expect(places.merge(city.id, city.id)).rejects.toThrow('A place cannot be merged into itself.');
        await expect(places.remove('nope')).rejects.toThrow('This place (or name) is gone.');
    });

    it('merges and removes with undo', async () => {
        await turn(env, 'Inn');
        await turn(env, 'Inn');
        const inn = named('Inn');
        const tavern = await places.create('Tavern');
        const cellar = await places.create('Cellar', inn.id);
        await places.merge(tavern.id, inn.id);
        expect(named('Tavern')).toMatchObject({ aliases: ['Inn'], firstSeen: 0, lastSeen: 2 });
        expect(named('Cellar').parent).toBe(tavern.id);
        expect(places.current()?.id).toBe(tavern.id);
        expect(env.journal.records.at(-1)?.summary).toBe('The place «Inn» merged into «Tavern»');
        expect(await undoLast()).toBe(true);
        expect(named('Inn').visits).toHaveLength(1);
        expect(named('Tavern')).toMatchObject({ aliases: [], visits: [] });
        expect(named('Cellar').parent).toBe(inn.id);
        expect(places.current()?.id).toBe(inn.id);

        await places.remove(inn.id);
        expect(named('Cellar').parent).toBeNull();
        expect(places.current()).toBeNull();
        expect(env.journal.records.at(-1)?.summary).toBe('Place «Inn» removed');
        expect(await undoLast()).toBe(true);
        expect(named('Cellar').parent).toBe(inn.id);
        expect(places.current()?.id).toBe(inn.id);
        void cellar;
    });

    it('acts on candidates', async () => {
        const city = await places.create('Port Royal');
        await turn(env, 'Docks, Port Royal');
        await turn(env, 'Smithy, Port Royal');
        expect(places.candidates().map((candidate) => [candidate.key, candidate.parent])).toEqual([
            ['docks', city.id],
            ['smithy', city.id],
        ]);
        const smithy = await places.createCandidate('smithy');
        expect(smithy).toMatchObject({ name: 'Smithy', parent: city.id });
        expect(places.current()?.id).toBe(smithy.id);
        expect(env.journal.records.at(-1)?.kind).toBe('places.create');
        await places.mergeCandidate('docks', city.id);
        expect(named('Port Royal').aliases).toEqual(['Docks']);
        expect(env.journal.records.at(-1)?.summary).toBe('«Docks» is another name of the place «Port Royal»');
        await turn(env, 'Harbour');
        await places.dismissCandidate('harbour');
        await turn(env, 'Harbour');
        expect(places.candidates()).toEqual([]);
        await expect(places.createCandidate('nope')).rejects.toThrow('This place (or name) is gone.');
    });
});

describe('description entry', () => {
    it('needs the chat canon', async () => {
        const inn = await places.create('Inn');
        await expect(places.ensureEntry(inn.id)).rejects.toThrow('the «Chat canon» module is off');
        await expect(places.ensureEntry('nope')).rejects.toThrow('This place (or name) is gone.');
    });

    it('creates a place entry in the canon once and reuses it', async () => {
        const canon = new FakeCanon();
        canon.forms = { Таверна: ['Таверна', 'Таверны', 'Таверне'] };
        env.modules.expose('canon', canon);
        const city = await places.create('Port Royal');
        const inn = await places.create('Таверна', city.id);
        await places.update(inn.id, { aliases: ['Rusty Anchor'] });
        const entry = await places.ensureEntry(inn.id);
        expect(entry).toEqual({ world: canon.book, uid: 0 });
        expect(canon.drafts).toEqual([
            {
                entry: {
                    comment: 'Таверна',
                    key: ['Таверна', 'Rusty Anchor', 'Таверны', 'Таверне'],
                    content: 'Place: Таверна\nPart of: Port Royal\nDescription: ',
                },
                meta: { kind: 'addition', status: 'active', origin: 'entity', type: 'place' },
            },
        ]);
        expect(named('Таверна').entry).toEqual(entry);
        expect(await places.ensureEntry(inn.id)).toEqual(entry);
        expect(canon.drafts).toHaveLength(1);

        const top = await places.ensureEntry(city.id);
        expect(canon.drafts[1]?.entry.content).toBe('Place: Port Royal\nDescription: ');
        // A deleted entry is made again.
        await canon.remove(top.uid);
        expect((await places.ensureEntry(city.id)).uid).toBe(2);
    });

    it('binds an existing place entry of the canon by name', async () => {
        const canon = new FakeCanon();
        canon.items.push({
            uid: 7,
            meta: { kind: 'addition', status: 'active', origin: 'user', type: 'place', createdAt: 1, updatedAt: 1 },
            entry: { comment: 'Old Mill', key: ['mill'] },
        });
        canon.items.push({
            uid: 8,
            meta: { kind: 'addition', status: 'active', origin: 'user', type: 'item', createdAt: 1, updatedAt: 1 },
            entry: { comment: 'Lighthouse', key: [] },
        });
        env.modules.expose('canon', canon);
        const mill = await places.create('Old Mill');
        expect(await places.ensureEntry(mill.id)).toEqual({ world: canon.book, uid: 7 });
        expect(canon.drafts).toEqual([]);
        const lighthouse = await places.create('Lighthouse');
        expect((await places.ensureEntry(lighthouse.id)).uid).toBe(0);
    });

    it('checks entries of other books through the lore store', async () => {
        const canon = new FakeCanon();
        env.modules.expose('canon', canon);
        const books: Record<string, { entries: Record<string, unknown> }> = { Atlas: { entries: { '4': {} } } };
        env.modules.expose('loreStore', { load: async (name: string) => books[name] ?? null });
        const inn = await places.create('Inn');
        await places.update(inn.id, { entry: { world: 'Atlas', uid: 4 } });
        expect(await places.ensureEntry(inn.id)).toEqual({ world: 'Atlas', uid: 4 });
        delete books.Atlas;
        expect(await places.ensureEntry(inn.id)).toEqual({ world: canon.book, uid: 0 });
    });
});
