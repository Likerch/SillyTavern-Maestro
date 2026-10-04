import { describe, expect, it } from 'vitest';
import {
    addDrafts,
    capFacts,
    cleanTopics,
    dropForMessage,
    emptyKnowledgeDoc,
    eventsFromReply,
    eventsFromSignals,
    joinNames,
    keywordTopics,
    knows,
    nameTopics,
    normalizeFact,
    normalizeKnowledgeDoc,
    sameFact,
    setKnown,
    splitSentences,
} from '../../src/domain/knowledge-facts';
import type { KnowledgeFactData, NameInfo, NameLookup } from '../../src/domain/knowledge-facts';

const NAMES: NameInfo[] = [
    { name: 'Anna', aliases: ['Annie'], forms: ['Анна', 'Анны', 'Анне', 'Анну', 'Анной'] },
    { name: 'Kai', forms: ['Кай', 'Кая', 'Каю', 'Каем'] },
    { name: 'Marcus', forms: [] },
    { name: 'Марк' },
];

const lookup: NameLookup = (name) => NAMES.find((info) => info.name.toLowerCase() === name.toLowerCase()) ?? null;

function fact(fields: Partial<KnowledgeFactData> = {}): KnowledgeFactData {
    return {
        id: fields.id ?? 'f1',
        text: 'Quest begun: Find the map',
        topics: ['карта'],
        knownBy: ['Anna'],
        secret: false,
        sourceMessage: 1,
        at: 1,
        ...fields,
    };
}

describe('the document', () => {
    it('repairs stored facts and drops junk and duplicate ids', () => {
        const doc = normalizeKnowledgeDoc({
            facts: [
                { id: 'a', text: ' Kiss ', topics: ['kiss', 3, 'kiss'], knownBy: ['Anna', 'anna', 'Kai'], at: 'x' },
                { id: 'a', text: 'again' },
                { id: '', text: 'no id' },
                { id: 'b', text: '' },
                'junk',
                { id: 'c', text: 'Secret', secret: true, sourceMessage: 4, at: 9, quote: ' «Тише» ' },
            ],
        });
        expect(doc.facts).toEqual([
            {
                id: 'a',
                text: 'Kiss',
                topics: ['kiss'],
                knownBy: ['Anna', 'Kai'],
                secret: false,
                sourceMessage: -1,
                at: 0,
            },
            {
                id: 'c',
                text: 'Secret',
                topics: [],
                knownBy: [],
                secret: true,
                sourceMessage: 4,
                at: 9,
                quote: '«Тише»',
            },
        ]);
        expect(normalizeKnowledgeDoc(null)).toEqual(emptyKnowledgeDoc());
        expect(normalizeKnowledgeDoc({ facts: 'x' })).toEqual({ facts: [] });
        expect(normalizeFact(null)).toBeNull();
    });

    it('returns a copy, never the stored object', () => {
        const raw = { facts: [fact()] };
        const doc = normalizeKnowledgeDoc(raw);
        doc.facts[0]!.knownBy.push('Bob');
        expect(raw.facts[0]!.knownBy).toEqual(['Anna']);
    });
});

describe('topics', () => {
    it('takes keywords of free text: names keep their case, small and common words go', () => {
        expect(keywordTopics('Escape Velmora with Anna')).toEqual(['escape', 'Velmora', 'Anna']);
        expect(keywordTopics('Найти карту Старого Мельника', 2)).toEqual(['карту', 'Старого']);
        expect(keywordTopics('a to of the')).toEqual([]);
        expect(keywordTopics('Something', 0)).toEqual([]);
    });

    it('takes a name with its aliases and Russian forms from the lookup', () => {
        expect(nameTopics('Anna', lookup)).toEqual(['Anna', 'Annie', 'Анна', 'Анны', 'Анне', 'Анну', 'Анной']);
        expect(nameTopics('annie', (name) => (name === 'annie' ? NAMES[0] : null))).toEqual([
            'Anna',
            'annie',
            'Annie',
            'Анна',
            'Анны',
            'Анне',
            'Анну',
            'Анной',
        ]);
        expect(nameTopics('Stranger')).toEqual(['Stranger']);
    });

    it('leaves the persona and duplicates out and caps the list', () => {
        expect(cleanTopics(['Kai', 'Кай', 'Anna', 'anna', 'x', ''], ['Kai', 'Кай'])).toEqual(['Anna']);
        const many = Array.from({ length: 30 }, (_, index) => `Name${index}`);
        expect(cleanTopics(many, [])).toHaveLength(16);
    });

    it('joins names in English', () => {
        expect(joinNames([])).toBe('');
        expect(joinNames(['Anna'])).toBe('Anna');
        expect(joinNames(['Anna', 'Kai'])).toBe('Anna and Kai');
        expect(joinNames(['Anna', 'Kai', 'Bob'])).toBe('Anna, Kai and Bob');
    });
});

describe('facts of signals', () => {
    const options = { persona: 'Kai', personaNames: ['Кай', 'Кая'], lookup };

    it('turns the scene signals into short English facts with topics and subjects', () => {
        const drafts = eventsFromSignals(
            [
                { kind: 'quest.added', data: { title: 'Escape Velmora with Anna', main: true } },
                { kind: 'quest.removed', data: { title: 'Pay Bob back' } },
                { kind: 'relationship.changed', data: { name: 'Anna', from: 'Friend', to: 'Lover' } },
                { kind: 'relationship.changed', data: { name: 'Marcus', to: 'Enemy' } },
                { kind: 'location.changed', data: { from: 'Port', to: 'Old Mill' } },
                { kind: 'character.appeared', data: { name: 'Marcus', first: true } },
                { kind: 'character.left', data: { name: 'Anna' } },
                { kind: 'name.new', data: { name: 'Ирэн', quoted: true } },
                { kind: 'alias.added', data: { name: 'Marcus', aliases: ['the Hooded Man', 'Капюшон'] } },
                { kind: 'time.skipped', data: {} },
                { kind: 'memory.added', data: { items: [] } },
            ],
            options,
        );
        expect(drafts.map((item) => item.text)).toEqual([
            'Quest begun: Escape Velmora with Anna',
            'Quest over: Pay Bob back',
            'Anna now regards Kai as Lover (was Friend)',
            'Marcus now regards Kai as Enemy',
            'Kai went to Old Mill',
            'Marcus joined the scene',
            'Anna left the scene',
            'The name Ирэн came up',
            'Marcus is also called the Hooded Man and Капюшон',
        ]);
        expect(drafts[0]!.topics).toEqual(['escape', 'Velmora', 'Anna']);
        expect(drafts[0]!.subjects).toEqual([]);
        expect(drafts[1]!.topics).toEqual(['Bob', 'back']);
        expect(drafts[2]!.topics).toEqual(['Anna', 'Annie', 'Анна', 'Анны', 'Анне', 'Анну', 'Анной']);
        expect(drafts[2]!.subjects).toEqual(['Anna']);
        expect(drafts[4]!.topics).toEqual(['Mill']);
        expect(drafts[8]!.topics).toEqual(['Marcus', 'the Hooded Man', 'Капюшон']);
    });

    it('skips signals without the data they need and says «the user» without a persona', () => {
        const drafts = eventsFromSignals(
            [
                { kind: 'quest.added', data: {} },
                { kind: 'relationship.changed', data: { name: 'Anna' } },
                { kind: 'location.changed' },
                { kind: 'character.appeared', data: {} },
                { kind: 'character.left', data: {} },
                { kind: 'name.new', data: {} },
                { kind: 'alias.added', data: { name: 'Anna', aliases: [] } },
                { kind: 'relationship.changed', data: { name: 'Anna', to: 'Ally' } },
                { kind: 'relationship.changed', data: { name: 'Anna', to: 'Ally' } },
            ],
            { persona: '' },
        );
        expect(drafts.map((item) => item.text)).toEqual(['Anna now regards the user as Ally']);
    });

    it('uses the place forms when the lookup knows the place', () => {
        const place: NameLookup = (name) => (name === 'Таверна' ? { name: 'Таверна', forms: ['Таверне'] } : null);
        const [moved] = eventsFromSignals([{ kind: 'location.changed', data: { to: 'Таверна' } }], {
            persona: 'Kai',
            lookup: place,
        });
        expect(moved?.topics).toEqual(['Таверна', 'Таверне']);
    });
});

describe('facts of the reply', () => {
    const options = { persona: 'Kai', personaNames: ['Кай'], lookup, names: NAMES };

    it('splits sentences', () => {
        expect(splitSentences('Он ушёл. «Стой!» Она осталась…\n\nКонец')).toEqual([
            'Он ушёл.',
            '«Стой!',
            'Она осталась…',
            'Конец',
        ]);
        expect(splitSentences(`${'a'.repeat(600)}. Short.`)).toEqual(['Short.']);
    });

    it('takes a sentence with a key event word that names someone', () => {
        const drafts = eventsFromReply(
            'Анна поцеловала Кая у ворот. Дождь шёл весь день. Кто-то убил стражника. Марк погиб в бою.',
            options,
        );
        expect(drafts.map((item) => item.text)).toEqual(['Kiss involving Anna and Kai', 'Death involving Марк']);
        expect(drafts[0]!.quote).toBe('Анна поцеловала Кая у ворот.');
        expect(drafts[0]!.subjects).toEqual(['Anna', 'Kai']);
        expect(drafts[0]!.topics).toEqual([
            'Anna',
            'Annie',
            'Анна',
            'Анны',
            'Анне',
            'Анну',
            'Анной',
            'поцелуй',
            'поцеловал',
            'kiss',
        ]);
    });

    it('reads English replies and stops at the limit', () => {
        const drafts = eventsFromReply(
            'Anna kissed Kai. Marcus was arrested. Anna stole the key. Marcus betrayed them.',
            options,
        );
        expect(drafts.map((item) => item.text)).toEqual(['Kiss involving Anna and Kai', 'Arrest involving Marcus']);
        expect(eventsFromReply('Anna kissed Kai. Anna kissed Kai again.', { ...options, max: 5 })).toHaveLength(1);
    });

    it('gives nothing without names, text or room', () => {
        expect(eventsFromReply('Anna kissed Kai.', { ...options, names: [] })).toEqual([]);
        expect(eventsFromReply('   ', options)).toEqual([]);
        expect(eventsFromReply('Anna kissed Kai.', { ...options, max: 0 })).toEqual([]);
        expect(eventsFromReply('Он поцеловал её. Who killed whom?', options)).toEqual([]);
    });

    it('knows every kind of key event', () => {
        const lines = [
            'Marcus was murdered.',
            'Marcus died.',
            'Marcus betrayed us.',
            'Анна: «Я люблю тебя».',
            'Marcus stole the gold.',
            'Marcus is wounded.',
            'Anna is pregnant.',
            'Anna and Marcus are engaged.',
            'Marcus escaped.',
            'Marcus was arrested.',
            'Marcus has a secret.',
        ];
        const glosses = lines.map((line) => eventsFromReply(line, options)[0]?.text);
        expect(glosses).toEqual([
            'Killing involving Marcus',
            'Death involving Marcus',
            'Betrayal involving Marcus',
            'Confession of love involving Anna',
            'Theft involving Marcus',
            'Injury involving Marcus',
            'Pregnancy involving Anna',
            'Engagement or marriage involving Anna and Marcus',
            'Escape involving Marcus',
            'Arrest involving Marcus',
            'A revealed secret involving Marcus',
        ]);
    });
});

describe('the store', () => {
    let next = 0;
    const newId = () => `k${++next}`;

    it('adds the drafts of a turn with the cast and the subjects as knowers', () => {
        const doc = emptyKnowledgeDoc();
        const added = addDrafts(
            doc,
            [
                { text: 'Kiss involving Anna and Marcus', topics: ['Anna'], subjects: ['Marcus'], quote: 'q' },
                { text: '  ', topics: [], subjects: [] },
            ],
            { knownBy: ['Anna', 'Kai', 'anna'], sourceMessage: 3, at: 10, newId, max: 300 },
        );
        expect(added).toHaveLength(1);
        expect(doc.facts[0]).toMatchObject({
            text: 'Kiss involving Anna and Marcus',
            knownBy: ['Anna', 'Kai', 'Marcus'],
            secret: false,
            sourceMessage: 3,
            at: 10,
            quote: 'q',
        });
        // The same turn read again adds nothing.
        expect(
            addDrafts(doc, [{ text: 'kiss involving anna and marcus', topics: [], subjects: [] }], {
                knownBy: [],
                sourceMessage: 3,
                at: 11,
                newId,
                max: 300,
            }),
        ).toEqual([]);
        expect(sameFact({ text: 'A', sourceMessage: 1 }, { text: 'a ', sourceMessage: 1 })).toBe(true);
        expect(sameFact({ text: 'A', sourceMessage: 1 }, { text: 'A', sourceMessage: 2 })).toBe(false);
    });

    it('caps the store: oldest scene facts first, secrets last', () => {
        const facts = [
            fact({ id: 's1', secret: true, at: 1 }),
            fact({ id: 'a', at: 2 }),
            fact({ id: 'b', at: 3 }),
            fact({ id: 's2', secret: true, at: 4 }),
            fact({ id: 'c', at: 5 }),
        ];
        expect(capFacts(facts, 3).map((item) => item.id)).toEqual(['s1', 's2', 'c']);
        expect(capFacts(facts, 1).map((item) => item.id)).toEqual(['s2']);
        expect(capFacts(facts, 10)).toHaveLength(5);
        const doc = { facts: facts.slice() };
        const added = addDrafts(doc, [{ text: 'New', topics: [], subjects: [] }], {
            knownBy: [],
            sourceMessage: 9,
            at: 9,
            newId,
            max: 2,
        });
        expect(doc.facts.map((item) => item.id)).toEqual(['s1', 's2']);
        expect(added).toEqual([]);
    });

    it('drops the facts of an invalidated message', () => {
        const make = () => ({
            facts: [
                fact({ id: 'a', sourceMessage: 1 }),
                fact({ id: 'b', sourceMessage: 3 }),
                fact({ id: 's', sourceMessage: 3, secret: true }),
                fact({ id: 'c', sourceMessage: 5 }),
            ],
        });
        let doc = make();
        expect(dropForMessage(doc, 3, 'swiped')).toBe(2);
        expect(doc.facts.map((item) => item.id)).toEqual(['a', 'c']);
        doc = make();
        expect(dropForMessage(doc, 3, 'edited')).toBe(1);
        expect(doc.facts.map((item) => item.id)).toEqual(['a', 's', 'c']);
        doc = make();
        expect(dropForMessage(doc, 3, 'deleted')).toBe(3);
        expect(doc.facts.map((item) => item.id)).toEqual(['a']);
    });

    it('marks who knows', () => {
        const item = fact({ knownBy: ['Anna'] });
        expect(knows(item, ['anna'])).toBe(true);
        expect(knows(item, ['Bob', 'Annie'])).toBe(false);
        expect(setKnown(item, 'Bob', true)).toBe(true);
        expect(setKnown(item, 'bob', true)).toBe(false);
        expect(item.knownBy).toEqual(['Anna', 'Bob']);
        expect(setKnown(item, 'ANNA', false)).toBe(true);
        expect(setKnown(item, 'Anna', false)).toBe(false);
        expect(setKnown(item, '  ', true)).toBe(false);
        expect(item.knownBy).toEqual(['Bob']);
    });
});
