import { describe, expect, it } from 'vitest';
import { escapeBunnyMoTags } from '../../src/domain/rules-display';

describe('escapeBunnyMoTags', () => {
    it('escapes <KEY:VALUE> tags with an upper-case key', () => {
        expect(escapeBunnyMoTags('<SPECIES:ELF>, <ATTACHMENT:FEARFUL_AVOIDANT>')).toBe(
            '&lt;SPECIES:ELF&gt;, &lt;ATTACHMENT:FEARFUL_AVOIDANT&gt;',
        );
        expect(escapeBunnyMoTags('<Name:Atsu_Ibn_Oba_Al-Masri> <Dere:Sadodere>')).toBe(
            '&lt;Name:Atsu_Ibn_Oba_Al-Masri&gt; &lt;Dere:Sadodere&gt;',
        );
        expect(escapeBunnyMoTags('<BunnymoTags:Entry Name>')).toBe('&lt;BunnymoTags:Entry Name&gt;');
        expect(escapeBunnyMoTags('<WHEELCHAIR:CHECKED>')).toBe('&lt;WHEELCHAIR:CHECKED&gt;');
    });

    it('escapes bare MBTI tags and BunnyMo wrappers in any case', () => {
        expect(escapeBunnyMoTags('<INTJ-U> <ENFP-H>')).toBe('&lt;INTJ-U&gt; &lt;ENFP-H&gt;');
        expect(
            escapeBunnyMoTags('<BunnymoTags>x</BunnymoTags><BunnyMoTags>y</BunnyMoTags><Linguistics>z</linguistics>'),
        ).toBe(
            '&lt;BunnymoTags&gt;x&lt;/BunnymoTags&gt;&lt;BunnyMoTags&gt;y&lt;/BunnyMoTags&gt;&lt;Linguistics&gt;z&lt;/linguistics&gt;',
        );
        expect(escapeBunnyMoTags('<Genre>g</Genre><MentalHealth>m</MentalHealth>')).toBe(
            '&lt;Genre&gt;g&lt;/Genre&gt;&lt;MentalHealth&gt;m&lt;/MentalHealth&gt;',
        );
    });

    it('escapes bare upper-case BunnyMo wrappers and tags', () => {
        expect(escapeBunnyMoTags('<PHYSICAL> <SPECIES:HUMAN> </PHYSICAL> <NSFW>x</NSFW> <PTSD>')).toBe(
            '&lt;PHYSICAL&gt; &lt;SPECIES:HUMAN&gt; &lt;/PHYSICAL&gt; &lt;NSFW&gt;x&lt;/NSFW&gt; &lt;PTSD&gt;',
        );
    });

    it('never touches real HTML', () => {
        const html = [
            '<div class="a:b">x</div>',
            '<span style="color:red">y</span>',
            '<img src="data:image/png;base64,AAA" alt="z">',
            '<a href="https://example.com">link</a>',
            '<BR><B>bold</B><P>para</P><HR/>',
            '<font color=red>f</font>',
            '<q>quote</q>',
            '<details><summary>s</summary>d</details>',
            '<https://example.com> <mailto:me@example.com>',
            '<HTTPS://EXAMPLE.COM>',
            '<intj-u> <species:elf>',
            '<my-widget>w</my-widget>',
            '<span data-nai-img="abc"></span>',
        ].join('\n');
        expect(escapeBunnyMoTags(html)).toBe(html);
    });

    it('escapes tags next to HTML without touching the HTML', () => {
        expect(escapeBunnyMoTags('<b><TRAIT:STOIC></b>')).toBe('<b>&lt;TRAIT:STOIC&gt;</b>');
    });

    it('is idempotent and leaves text without tags alone', () => {
        const once = escapeBunnyMoTags('<SPECIES:ELF> <INTJ-U>');
        expect(escapeBunnyMoTags(once)).toBe(once);
        expect(escapeBunnyMoTags('no tags here')).toBe('no tags here');
        expect(escapeBunnyMoTags('a < b > c')).toBe('a < b > c');
        expect(escapeBunnyMoTags('<KEY:multi\nline>')).toBe('<KEY:multi\nline>');
        expect(escapeBunnyMoTags(undefined as unknown as string)).toBe(undefined);
    });
});
