import { describe, expect, it } from 'vitest';
import type { AuditCapture, AuditItem } from '../../src/domain/prompt-audit-map';
import {
    auditRules,
    fingerprintOf,
    itemFacets,
    pickSide,
    roleHits,
    sentences,
    shortQuote,
    withLengthException,
} from '../../src/domain/prompt-audit-rules';
import type { RuleHit } from '../../src/domain/prompt-audit-rules';
import { DEEPSEEK, item, mergedTrailingCapture, realCaseCapture } from '../helpers/prompt-audit-fixtures';

function capture(items: AuditItem[], extra: Partial<AuditCapture> = {}): AuditCapture {
    return { v: 1, at: 1, chatId: 'c', type: 'normal', source: 'turn', items, messages: [], ...extra };
}

const preset = (key: string, text: string) => item({ ref: `preset:${key}`, owner: 'preset', label: key, key, text });

function only(hits: RuleHit[], topic: RuleHit['topic']): RuleHit[] {
    return hits.filter((hit) => hit.topic === topic);
}

describe('sentences', () => {
    it('cuts a text into exact substrings at line ends and sentence ends', () => {
        const text = 'Reply in English. Keep it to 1.5 pages!\n<task>\nNever skip the tracker… Done';
        const list = sentences(text);
        expect(list.map((entry) => entry.text)).toEqual([
            'Reply in English.',
            'Keep it to 1.5 pages!',
            '<task>',
            'Never skip the tracker…',
            'Done',
        ]);
        for (const entry of list) expect(text.slice(entry.start, entry.start + entry.text.length)).toBe(entry.text);
    });

    it('shortens long quotes for display', () => {
        expect(shortQuote('a  b\n c')).toBe('a b c');
        expect(shortQuote('x'.repeat(300), 10)).toHaveLength(10);
    });
});

describe('itemFacets', () => {
    it('reads the reply language in English and Russian, including «по-русски»', () => {
        expect(itemFacets('Always reply in English.').language.get('en')?.required).toBe('Always reply in English.');
        expect(itemFacets('[Отвечай по-русски.]').language.get('ru')?.required).toBeTruthy();
        expect(itemFacets('Пиши только на русском языке.').language.get('ru')?.required).toBeTruthy();
    });

    it('leaves out the language of image tags, captions and tracker fields', () => {
        expect(itemFacets('Write the image tags in English.').language.size).toBe(0);
        expect(itemFacets('Write the tracker field names in English.').language.size).toBe(0);
    });

    it('reads narration person and tense, but not those of character thoughts', () => {
        const facets = itemFacets('Write in third person, past tense. Thoughts are written in first person.');
        expect(facets.pov.get('third')?.required).toBeTruthy();
        expect(facets.pov.has('first')).toBe(false);
        expect(facets.tense.get('past')?.required).toBeTruthy();
    });

    it('reads length limits, «one line» included', () => {
        const facets = itemFacets('Keep it short: one line, no more than 150 words.');
        expect(facets.lengths.map((entry) => entry.limit)).toEqual([
            { unit: 'lines', min: 0, max: 1 },
            { unit: 'words', min: 0, max: 150 },
        ]);
        expect(itemFacets('Ответ — одной строкой.').lengths[0]?.limit).toEqual({ unit: 'lines', min: 0, max: 1 });
        expect(itemFacets('Summaries under 20 words.').lengths).toEqual([]);
    });

    it('tells required reply parts and formats from forbidden ones', () => {
        const des = itemFacets('At the start of every reply attach the tracker JSON in a ```json code block.');
        expect(des.parts.get('json')?.required).toBeTruthy();
        expect(des.parts.get('code')?.required).toBeTruthy();
        expect(des.everyTurn).toHaveLength(1);
        const strict = itemFacets('Do not use HTML. Никакого markdown, без HTML-вставок. No code blocks.');
        expect(strict.parts.get('html')?.forbidden).toBeTruthy();
        expect(strict.parts.get('code')?.forbidden).toBeTruthy();
        expect(itemFacets('Не используй markdown.').parts.get('markdown')?.forbidden).toBeTruthy();
        expect(
            itemFacets('Include an info box at the end of every reply.').parts.get('infobox')?.required,
        ).toBeTruthy();
        expect(itemFacets('Plain text only.').plain).toBe('Plain text only.');
        expect(itemFacets('Пиши только простой текст.').plain).toBeTruthy();
    });

    it('reads writing for the user and consent loops (EN + RU)', () => {
        expect(itemFacets('Never speak or act for {{user}}.').userAgency.forbidden).toBeTruthy();
        expect(itemFacets("Describe {{user}}'s actions and dialogue.").userAgency.required).toBeTruthy();
        expect(itemFacets('Никогда не пиши за {{user}}.').userAgency.forbidden).toBeTruthy();
        expect(itemFacets('Описывай действия {{user}} подробно.').userAgency.required).toBeTruthy();
        expect(itemFacets('Always ask {{user}} for consent before anything intimate.').askUser.required).toBeTruthy();
        expect(itemFacets('Never ask the user what they do next.').askUser.forbidden).toBeTruthy();
        expect(itemFacets('Не спрашивай игрока, что он делает дальше.').askUser.forbidden).toBeTruthy();
    });

    it('counts pictures', () => {
        expect(itemFacets('Place 1 to 3 picture markers in every reply.').images).toEqual([
            { min: 1, max: 3, quote: 'Place 1 to 3 picture markers in every reply.' },
        ]);
        expect(itemFacets('No more than 1 image per reply.').images[0]).toMatchObject({ min: 0, max: 1 });
        expect(itemFacets('Не более 2 картинок в ответе.').images[0]).toMatchObject({ min: 0, max: 2 });
        expect(itemFacets('Exactly one picture per reply.').images[0]).toMatchObject({ min: 1, max: 1 });
        expect(itemFacets('Do not include images.').images[0]).toMatchObject({ min: 0, max: 0 });
    });

    it('reads the pace: the story pushed every turn, or the user leading', () => {
        const drive = itemFacets('Every turn something happens in the world: an event, a complication or a twist.');
        expect(drive.pacing.has('drive')).toBe(true);
        expect(drive.everyTurn).toHaveLength(1);
        expect(itemFacets('Каждый ход в мире что-то происходит.').pacing.has('drive')).toBe(true);
        expect(itemFacets('Не продвигай сюжет без игрока.').pacing.has('hold')).toBe(true);
        expect(itemFacets('Let {{user}} lead the scene.').pacing.has('hold')).toBe(true);
    });
});

describe('auditRules: the real case', () => {
    it('finds the tight reply: one line / ≤150 words against the tracker JSON, 1–3 pictures and a world event', () => {
        const hits = auditRules(realCaseCapture());
        const tight = only(hits, 'tight');
        expect(tight).toHaveLength(1);
        expect(tight[0]).toMatchObject({
            severity: 'high',
            a: { ref: 'preset:task', quote: 'Keep it short: one line, no more than 150 words.' },
            b: { ref: 'slot:dooms-tracker-inject' },
            demands: ['json', 'images', 'event'],
        });
        expect(tight[0]!.also?.map((side) => side.ref)).toEqual(['slot:nai_studio_markers', 'preset:world']);
        expect(tight[0]!.fix).toEqual({
            side: 'a',
            kind: 'edit',
            target: 'preset:task',
            before: 'Keep it short: one line, no more than 150 words.',
            after: 'Keep it short: one line, no more than 150 words (the limit is for the story text only; the tracker JSON and picture markers do not count toward it).',
            reason: 'exception',
        });
        // Most severe first.
        expect(hits[0]!.topic).toBe('tight');
    });

    it('flags the glued trailing system block with the tracker rules as serious on DeepSeek V4', () => {
        const hits = roleHits(mergedTrailingCapture());
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({
            topic: 'role',
            severity: 'high',
            quirk: 'systemMerge',
            a: { ref: 'slot:dooms-tracker-inject' },
            b: { ref: 'slot:nai_studio_markers' },
            values: { a: 'trailing', b: '17000' },
            fix: { kind: 'role', role: 'user', target: 'slot:dooms-tracker-inject' },
        });
    });

    it('accepts its own fix: a limit that leaves the extra parts out is not tight any more', () => {
        const fixed = realCaseCapture();
        const fix = only(auditRules(fixed), 'tight')[0]!.fix!;
        fixed.items[0]!.text = fixed.items[0]!.text.replace(fix.before!, fix.after!);
        // Neither the tight reply nor a format conflict with the parts the exception names.
        expect(auditRules(fixed).filter((hit) => hit.topic !== 'role')).toEqual([]);
        const russian = realCaseCapture();
        russian.items[0]!.text = 'Ответ — одной строкой, до 150 слов, не считая JSON трекера.';
        expect(only(auditRules(russian), 'tight')).toEqual([]);
    });

    it('writes the length exception in the language of the rule', () => {
        expect(withLengthException('Ответ — одной строкой, до 150 слов.', ['json', 'images'])).toBe(
            'Ответ — одной строкой, до 150 слов (лимит — только для текста истории; JSON трекера и маркеры картинок в него не входят).',
        );
        expect(withLengthException('Keep it under 100 words', ['json'])).toBe(
            'Keep it under 100 words (the limit is for the story text only; the tracker JSON do not count toward it)',
        );
    });
});

describe('auditRules: topics', () => {
    it('language: the preset says English, the DES-RU rule Russian — the preset side is fixed', () => {
        const hits = auditRules(
            capture([
                preset('main', 'Always reply in English.'),
                item({
                    ref: 'slot:desru_bunnymo_language',
                    owner: 'desru',
                    text: '[Язык ролевой игры — русский. Отвечай по-русски.]',
                }),
            ]),
        );
        const hit = only(hits, 'language')[0]!;
        expect(hit).toMatchObject({ severity: 'high', values: { a: 'en', b: 'ru' } });
        expect(hit.fix).toMatchObject({
            side: 'a',
            kind: 'remove',
            target: 'preset:main',
            before: 'Always reply in English.',
        });
    });

    it('narration person, tense and length limits', () => {
        const hits = auditRules(
            capture([
                preset('a', 'Write in third person. Use past tense. Replies of 300-500 words.'),
                preset('b', 'Пиши от первого лица. Используй настоящее время. Не более 100 слов.'),
            ]),
        );
        expect(only(hits, 'pov')[0]?.values).toEqual({ a: 'third', b: 'first' });
        expect(only(hits, 'tense')[0]?.values).toEqual({ a: 'past', b: 'present' });
        expect(only(hits, 'length')[0]?.values).toEqual({ a: '300-500 words', b: '≤100 words' });
    });

    it('formats: forbidden HTML against DES HTML, plain text against markdown', () => {
        const hits = auditRules(
            capture([
                preset('rules', 'Do not use HTML in replies.'),
                item({
                    ref: 'slot:dooms-tracker-html',
                    owner: 'des',
                    text: 'Include inline HTML pieces in the reply when it fits.',
                }),
                item({
                    ref: 'slot:maestro_messageStyle.hint',
                    owner: 'maestro',
                    module: 'messageStyle',
                    text: 'Plain text only.',
                }),
                item({ ref: 'card:system', owner: 'card', key: 'system', text: 'Always use *asterisks* for actions.' }),
            ]),
        );
        const formats = only(hits, 'format');
        expect(formats.map((hit) => [hit.a.ref, hit.b?.ref])).toEqual([
            ['preset:rules', 'slot:dooms-tracker-html'],
            ['slot:dooms-tracker-html', 'slot:maestro_messageStyle.hint'],
            ['slot:maestro_messageStyle.hint', 'card:system'],
        ]);
        expect(formats[0]!.fix).toMatchObject({ target: 'preset:rules', kind: 'remove' });
        expect(formats[1]!.values).toEqual({ a: 'html', b: 'plain' });
        expect(formats[2]!.values).toEqual({ a: 'plain', b: 'markdown' });
    });

    it('writing for the user, asking the user, the number of pictures, the pace', () => {
        const hits = auditRules(
            capture([
                preset(
                    'a',
                    'Never speak or act for {{user}}. Always ask {{user}} for consent. No more than 1 image per reply.',
                ),
                item({
                    ref: 'slot:nai_studio_markers',
                    owner: 'nai',
                    text: "Describe {{user}}'s actions and dialogue. Never ask the user what they do next. Place 2 to 4 picture markers.",
                }),
                preset('world', 'Every turn something happens in the world.'),
                item({
                    ref: 'slot:maestro_director',
                    owner: 'maestro',
                    module: 'director',
                    text: 'Не продвигай сюжет без игрока.',
                }),
            ]),
        );
        expect(only(hits, 'userAgency')[0]).toMatchObject({ severity: 'medium', values: { a: 'no', b: 'yes' } });
        expect(only(hits, 'askUser')[0]).toMatchObject({ severity: 'low', values: { a: 'yes', b: 'no' } });
        expect(only(hits, 'images')[0]).toMatchObject({ values: { a: '0-1', b: '2-4' } });
        expect(only(hits, 'pacing')[0]).toMatchObject({
            a: { ref: 'preset:world' },
            b: { ref: 'slot:maestro_director' },
            fix: { target: 'preset:world' },
        });
    });

    it('duplicates from different owners: the preset copy goes (whole block → switched off)', () => {
        const text =
            'Characters must stay true to their personalities and remember what happened before in the story at all times.';
        const hits = auditRules(
            capture([
                preset('dup', text),
                item({
                    ref: 'slot:maestro_voices',
                    owner: 'maestro',
                    module: 'voices',
                    text: `${text} Speak in their own voices.`,
                }),
            ]),
        );
        const hit = only(hits, 'duplicate')[0]!;
        expect(hit.severity).toBe('low');
        expect(hit.fix).toMatchObject({
            kind: 'toggle',
            enabled: false,
            target: 'preset:dup',
            reason: 'duplicateBlock',
        });
        // Preset blocks among themselves are the Preset Studio's own analysis.
        expect(only(auditRules(capture([preset('x', text), preset('y', text)])), 'duplicate')).toEqual([]);
    });

    it('no role risks without model quirks; prefill and assistant-in-history risks with them', () => {
        const base = capture(
            [
                item({
                    ref: 'preset:note',
                    owner: 'preset',
                    key: 'note',
                    role: 'assistant',
                    place: 'chat',
                    text: 'I will keep it brief.',
                    message: 2,
                }),
                item({
                    ref: 'preset:prefill',
                    owner: 'preset',
                    key: 'prefill',
                    role: 'assistant',
                    text: 'Sure! Here is the reply:',
                    message: 4,
                }),
            ],
            {
                messages: [
                    { role: 'system', chars: 10, refs: [] },
                    { role: 'user', chars: 10, refs: [] },
                    { role: 'assistant', chars: 10, refs: ['preset:note'] },
                    { role: 'user', chars: 10, refs: [] },
                    { role: 'assistant', chars: 10, refs: ['preset:prefill'] },
                ],
            },
        );
        expect(roleHits(base)).toEqual([]);
        const hits = roleHits({ ...base, connection: { ...DEEPSEEK } });
        expect(hits.map((hit) => [hit.topic, hit.severity, hit.a.ref, hit.fix?.kind])).toEqual([
            ['assistantDepth', 'medium', 'preset:note', 'role'],
            ['prefill', 'high', 'preset:prefill', 'toggle'],
        ]);
    });

    it('picks the side that is safest to change', () => {
        const presetItem = preset('p', 'x');
        const des = item({ ref: 'slot:d', owner: 'des', text: 'x' });
        const bunny = item({ ref: 'lore:b#1', owner: 'bunnymo', text: 'x' });
        expect(pickSide(presetItem, des)).toBe('a');
        expect(pickSide(des, presetItem)).toBe('b');
        expect(pickSide(bunny, des)).toBe('b');
    });
});

describe('fingerprints', () => {
    it('keep the topic, the pair and the values, not the wording', () => {
        const hit: RuleHit = {
            topic: 'language',
            severity: 'high',
            a: { ref: 'preset:a', quote: 'Reply in English.' },
            b: { ref: 'slot:x', quote: 'Отвечай по-русски.' },
            values: { a: 'en', b: 'ru' },
        };
        const same = fingerprintOf({ ...hit, a: { ...hit.a, quote: 'Answer in English, please.' } });
        expect(same).toBe(fingerprintOf(hit));
        expect(fingerprintOf({ ...hit, a: hit.b!, b: hit.a, values: { a: 'ru', b: 'en' } })).toBe(fingerprintOf(hit));
        expect(fingerprintOf({ ...hit, topic: 'ai' })).toBe('ai|preset:a|slot:x|');
    });
});
