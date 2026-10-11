import { describe, expect, it } from 'vitest';
import { storyText } from '../../src/domain/quality-text';
import {
    AROUND_ATTR,
    AROUND_CLOSE,
    AROUND_OPEN,
    ELSEWHERE_MAX_CHARS,
    aroundBox,
    elsewhereLine,
    findOffscreen,
    hasOffscreen,
    markForDisplay,
    offscreenLines,
    plainBody,
    promptForm,
    rewritePromptEntries,
    sceneSplitInstruction,
    stripOffscreen,
    wrapDisplay,
} from '../../src/domain/scene-split';
import type { PromptEntryInput } from '../../src/domain/scene-split';
import { cleanForAnalysis, cleanPreviewText } from '../../src/domain/text-clean';

const SCENE = 'Вера налила чай. «Садись», — сказала она.';
const BLOCK = '<offscreen>Тем временем Мира продала травы капитану.</offscreen>';
const REPLY = `${SCENE}\n\n${BLOCK}`;

describe('findOffscreen', () => {
    it('finds tag blocks with attributes, any case, and an unclosed one at the end', () => {
        const blocks = findOffscreen(`A <OFFSCREEN data-x="1">one</OFFSCREEN> B <offscreen>two`);
        expect(blocks.map((block) => [block.body, block.closed, block.form])).toEqual([
            ['one', true, 'tag'],
            ['two', false, 'tag'],
        ]);
    });

    it('takes a bracket line copied from the prompt for a block', () => {
        const text = `${SCENE}\n[Elsewhere, not in the scene: Mira sold herbs.]`;
        expect(findOffscreen(text).map((block) => [block.body, block.form])).toEqual([['Mira sold herbs.', 'bracket']]);
        expect(hasOffscreen(text)).toBe(true);
    });

    it('ignores a bracket line inside a tag block and texts without blocks', () => {
        const text = '<offscreen>[Elsewhere, not in the scene: x]</offscreen>';
        expect(findOffscreen(text)).toHaveLength(1);
        expect(findOffscreen(SCENE)).toEqual([]);
        expect(hasOffscreen(42)).toBe(false);
    });
});

describe('stripOffscreen', () => {
    it('removes blocks and stray closing tags, keeping the scene', () => {
        expect(stripOffscreen(REPLY)).toBe(SCENE);
        expect(stripOffscreen(`${SCENE}</offscreen>`)).toBe(SCENE);
        expect(stripOffscreen(`Start.\n\n${BLOCK}\n\n\n\nEnd.`)).toBe('Start.\n\nEnd.');
    });

    it('leaves a text without blocks exactly as it is', () => {
        const text = 'Text  with   spaces\n\n\n\nkept ';
        expect(stripOffscreen(text)).toBe(text);
        expect(stripOffscreen(undefined as unknown as string)).toBe('');
    });
});

describe('lines and the prompt form', () => {
    it('plainBody drops tags, brackets and extra whitespace', () => {
        expect(plainBody(' <font color="#f00">Мира</font>\n  [ушла] ')).toBe('Мира (ушла)');
        expect(offscreenLines(`${REPLY}\n<offscreen>  </offscreen>`)).toEqual([
            'Тем временем Мира продала травы капитану.',
        ]);
    });

    it('elsewhereLine joins the lines and cuts a long one at a word', () => {
        expect(elsewhereLine(['Mira left.', 'The rain stopped.'])).toBe(
            '[Elsewhere, not in the scene: Mira left. The rain stopped.]',
        );
        expect(elsewhereLine([])).toBe('');
        const long = elsewhereLine([`${'word '.repeat(200)}end`]);
        expect(long.length).toBeLessThanOrEqual(ELSEWHERE_MAX_CHARS + 40);
        expect(long.endsWith('…]')).toBe(true);
    });

    it('promptForm keeps one bracket line after the scene or drops the block', () => {
        expect(promptForm(REPLY, true)).toBe(
            `${SCENE}\n\n[Elsewhere, not in the scene: Тем временем Мира продала травы капитану.]`,
        );
        expect(promptForm(REPLY, false)).toBe(SCENE);
        expect(promptForm(SCENE, true)).toBe(SCENE);
        expect(promptForm(BLOCK, true)).toBe(
            '[Elsewhere, not in the scene: Тем временем Мира продала травы капитану.]',
        );
    });
});

describe('analysis never reads the block', () => {
    it('cleanForAnalysis and the quality prose leave it out', () => {
        expect(cleanForAnalysis(`\`\`\`json\n{"characters":[]}\n\`\`\`\n${REPLY}`)).toBe(SCENE);
        expect(cleanForAnalysis({ mes: REPLY })).toBe(SCENE);
        expect(storyText(REPLY)).not.toContain('Мира');
    });

    it('a chat preview ends with the scene, even when cut inside the block', () => {
        expect(cleanPreviewText(REPLY)).toBe(SCENE);
        expect(cleanPreviewText('...конец сцены. <offscreen>Мира ушла.</offscreen>')).toBe('...конец сцены.');
        // Only the block's tail was left in a cut preview: nothing of the story remains.
        expect(cleanPreviewText('...продала травы капитану.</offscreen>')).toBe('');
    });
});

describe('rewritePromptEntries', () => {
    const regex = (text: string) => text.replace(/\s?<[^<>]*>/g, '');
    const entry = (live: string | null, mes = live ?? 'user', depth = 0): PromptEntryInput => ({ mes, live, depth });

    it('the two newest replies keep a line, older ones lose the block (tags still in the prompt)', () => {
        const entries = [entry(REPLY), entry(null), entry(REPLY), entry(null), entry(REPLY), entry(null)];
        const out = rewritePromptEntries(entries, { keep: 2, continued: false, regex: null });
        expect(out[0]).toBe(SCENE);
        expect(out[2]).toContain('[Elsewhere, not in the scene:');
        expect(out[4]).toContain('[Elsewhere, not in the scene:');
        expect(out[1]).toBeUndefined();
    });

    it('re-runs the prompt regexes when they already stripped the tags, keeping reasoning before the text', () => {
        const stripped = regex(REPLY);
        expect(stripped).toContain('Мира');
        const entries = [entry(REPLY, `<think>plan</think>\n${stripped}`, 3)];
        const [kept] = rewritePromptEntries(entries, { keep: 1, continued: false, regex });
        expect(kept).toBe(
            `<think>plan</think>\n${SCENE}\n\n[Elsewhere, not in the scene: Тем временем Мира продала травы капитану.]`,
        );
        const [dropped] = rewritePromptEntries(entries, { keep: 0, continued: false, regex });
        expect(dropped).toBe(`<think>plan</think>\n${SCENE}`);
    });

    it('the reply being continued loses its block and does not count', () => {
        const entries = [entry(REPLY), entry(null), entry(REPLY)];
        const out = rewritePromptEntries(entries, { keep: 1, continued: true, regex: null });
        expect(out[2]).toBe(SCENE);
        expect(out[0]).toContain('[Elsewhere');
    });

    it('leaves entries it cannot match, entries without blocks and other entries alone', () => {
        const entries = [entry(REPLY, 'something else'), entry(SCENE), entry(null, BLOCK)];
        expect(rewritePromptEntries(entries, { keep: 2, continued: false, regex })).toEqual([
            undefined,
            undefined,
            undefined,
        ]);
        expect(rewritePromptEntries([entry(REPLY, regex(REPLY))], { keep: 1, continued: false, regex: null })).toEqual([
            undefined,
        ]);
    });
});

describe('sceneSplitInstruction', () => {
    it('names the tag, the story language and the player', () => {
        const ru = sceneSplitInstruction('ru', 'Кай');
        expect(ru).toContain('<offscreen>…</offscreen>');
        expect(ru).toContain('in Russian');
        expect(ru).toContain('Кай (the player)');
        expect(sceneSplitInstruction('en')).toContain('in English');
        expect(sceneSplitInstruction('en')).toContain('present or the player in it');
    });
});

describe('display', () => {
    it('markForDisplay moves every block after the scene between two markers', () => {
        const text = `Начало.\n${BLOCK}\nКонец.\n<offscreen>Второе.</offscreen>`;
        expect(markForDisplay(text)).toBe(
            `Начало.\n\nКонец.\n\n${AROUND_OPEN}\n\nТем временем Мира продала травы капитану.\n\nВторое.\n\n${AROUND_CLOSE}\n`,
        );
        expect(markForDisplay(SCENE)).toBe(SCENE);
        expect(markForDisplay(`${SCENE}\n<offscreen> </offscreen>`)).toBe(SCENE);
        expect(markForDisplay('')).toBe('');
    });

    it('a reply being written: an open block is folded already, a half-written tag is hidden', () => {
        expect(markForDisplay(`${SCENE}\n<offscreen>Мира`)).toContain(`${AROUND_OPEN}\n\nМира`);
        expect(markForDisplay(`${SCENE}\n<offs`)).toBe(`${SCENE}\n`);
        expect(markForDisplay(`${SCENE}\n<offscreen>Мира ушла</offscr`)).toContain('Мира ушла\n\n');
        expect(markForDisplay('a <o')).toBe('a <o');
    });

    it('wrapDisplay puts the HTML between the markers into one folded box at the end', () => {
        const html = `<p>Сцена.</p>\n<p>${AROUND_OPEN}</p>\n<p>Мира <em>ушла</em>.</p>\n<p>${AROUND_CLOSE}</p>`;
        const out = wrapDisplay(html, 'Вокруг');
        expect(out.startsWith('<p>Сцена.</p>')).toBe(true);
        expect(out).toContain(`<details class="maestro-around-box" ${AROUND_ATTR}="box">`);
        expect(out).toContain('<summary class="maestro-around-summary">Вокруг</summary>');
        expect(out).toContain('<p>Мира <em>ушла</em>.</p>');
        expect(out.endsWith('</details></div>')).toBe(true);
        expect(out).not.toContain(AROUND_OPEN);
        expect(out).not.toContain(AROUND_CLOSE);
    });

    it('the wrapper carries the inline style DES takes for a styled block, the label is escaped', () => {
        const box = aroundBox('<p>x</p>', '<b>&</b>');
        expect(box).toMatch(/^<div class="maestro-around" data-maestro-around="1" style="[^"]*margin[^"]*color[^"]*">/);
        expect(box).toContain('&lt;b&gt;&amp;&lt;/b&gt;');
    });

    it('font colours inside the box become spans', () => {
        const out = wrapDisplay(`${AROUND_OPEN}<p><font color="#a1b2c3">«Эй»</font></p>${AROUND_CLOSE}`, 'L');
        expect(out).toContain('<span style="color: #a1b2c3">«Эй»</span>');
        expect(out).not.toContain('<font');
        expect(aroundBox('<font>x</font>', 'L')).toContain('<span>x</span>');
    });

    it('keeps text after the close marker (a picture placeholder) before the box', () => {
        const out = wrapDisplay(`<p>A</p><p>${AROUND_OPEN}</p><p>B</p><p>${AROUND_CLOSE}</p><p>[nai:img:1]</p>`, 'L');
        expect(out.indexOf('[nai:img:1]')).toBeLessThan(out.indexOf('<details'));
    });

    it('without both markers or with an empty body it only drops markers', () => {
        expect(wrapDisplay('<p>Сцена.</p>', 'L')).toBe('<p>Сцена.</p>');
        expect(wrapDisplay(`<p>A</p>${AROUND_CLOSE}`, 'L')).toBe('<p>A</p>');
        expect(wrapDisplay(`<p>A</p><p>${AROUND_OPEN}</p><p> </p><p>${AROUND_CLOSE}</p>`, 'L')).toBe('<p>A</p>');
        expect(wrapDisplay(`<p>A</p><p>${AROUND_OPEN}</p><p>B</p>`, 'L')).toContain('<details');
        expect(wrapDisplay(undefined as unknown as string, 'L')).toBeUndefined();
    });
});
