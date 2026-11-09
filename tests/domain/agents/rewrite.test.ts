import { describe, expect, it } from 'vitest';
import { checkRewrite, protect, restore, serviceRanges } from '../../../src/domain/agents/rewrite';

const TRACKER = '```json\n{"infoBox": {"location": "Tavern"}, "characters": []}\n```\n';
const MECHANICS = '<mechanics>\nMira.hp -2\n</mechanics>';
const OFFSCREEN = '<offscreen>Far away, the guards change shifts.</offscreen>';

describe('protect', () => {
    it('cuts the leading tracker, inline markers and trailing blocks', () => {
        const reply = `${TRACKER}Mira laughs. [nai:img:abc] She pours the wine.\n\nThe door opens.\n\n${MECHANICS}\n${OFFSCREEN}`;
        const protectedReply = protect(reply);
        expect(protectedReply.text).toBe('Mira laughs.  She pours the wine.\n\nThe door opens.\n\n\n');
        expect(protectedReply.blocks.map((block) => block.where)).toEqual(['lead', 'inline', 'tail', 'tail']);
        expect(serviceRanges('plain text')).toEqual([]);
    });

    it('keeps a reply without blocks as it is', () => {
        expect(protect('Just text.')).toEqual({ text: 'Just text.', blocks: [] });
    });

    it('merges overlapping ranges (an image tag inside a CK dump)', () => {
        const reply = 'Text <BunnyMoTags><img src="x"></BunnyMoTags> end';
        expect(protect(reply).text).toBe('Text  end');
    });
});

describe('restore', () => {
    it('puts every block back where it was, after the same words', () => {
        const reply = `${TRACKER}Mira laughs. [nai:img:abc] She pours the wine.\n\n${MECHANICS}`;
        const protectedReply = protect(reply);
        const edited = 'Mira laughs. She pours the wine, slowly.';
        const out = restore(protectedReply, edited);
        expect(out.startsWith(TRACKER)).toBe(true);
        expect(out).toContain('Mira laughs. [nai:img:abc]');
        expect(out.endsWith(MECHANICS)).toBe(true);
        expect(out).toContain('She pours the wine, slowly.');
    });

    it('an inline block whose words were rewritten goes to the nearest paragraph break of the same place', () => {
        const reply = 'First paragraph is long enough here.\n\nSecond one. <img data-nai=\'{"p":1}\'> More.\n\nThird.';
        const protectedReply = protect(reply);
        const edited = 'Totally new opening words.\n\nCompletely different middle.\n\nThird.';
        const out = restore(protectedReply, edited);
        expect(out).toContain('<img data-nai=\'{"p":1}\'>');
        expect(out.indexOf('<img')).toBeGreaterThan(out.indexOf('opening'));
    });

    it('without blocks the edited text is the result', () => {
        expect(restore(protect('a'), 'b')).toBe('b');
    });
});

describe('checkRewrite', () => {
    it('refuses cut, much shorter or unchanged rewrites', () => {
        expect(checkRewrite('a long text here', 'other', [], true)).toEqual({ ok: false, reason: 'length' });
        expect(checkRewrite('a long text here', 'short', [], false)).toEqual({ ok: false, reason: 'shrunk' });
        expect(checkRewrite('a long text here', 'short', ['cut the rambling'], false)).toEqual({ ok: true });
        expect(checkRewrite(' same ', 'same', [], false)).toEqual({ ok: false, reason: 'same' });
        expect(checkRewrite('a long text here', 'a longer text here!', [], false)).toEqual({ ok: true });
    });
});
