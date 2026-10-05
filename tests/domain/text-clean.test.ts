import { describe, expect, it } from 'vitest';
import {
    cleanForAnalysis,
    isCkDumpBody,
    isHtmlElementName,
    isImagePost,
    stripCkDumps,
    stripDesTrackerJson,
    stripHtml,
    stripNaiPlaceholders,
} from '../../src/domain/text-clean';

const TRACKER = '{"quests":{"main":"Find the key"},"infoBox":{"location":"Inn"},"characters":[{"name":"Lira"}]}';

describe('stripDesTrackerJson', () => {
    it('removes a leading ```json tracker block of together mode', () => {
        const text = `\`\`\`json\n${TRACKER}\n\`\`\`\n\nLira smiles.`;
        expect(stripDesTrackerJson(text)).toBe('Lira smiles.');
    });

    it('accepts ```markdown, bare fences, leading whitespace and CRLF', () => {
        expect(stripDesTrackerJson(`  \`\`\`markdown\r\n${TRACKER}\r\n\`\`\`\r\nText`)).toBe('Text');
        expect(stripDesTrackerJson(`\`\`\`\n${TRACKER}\n\`\`\`\nText`)).toBe('Text');
    });

    it('removes an unfenced leading tracker object, strings with braces included', () => {
        const json = '{"characterThoughts":[{"name":"A","thoughts":"a } brace \\" quote"}]}';
        expect(stripDesTrackerJson(`${json}\nStory.`)).toBe('Story.');
    });

    it('recognises broken tracker JSON by its section keys', () => {
        expect(stripDesTrackerJson('```json\n{"infoBox": {"location": "Inn",}}\n```\nStory')).toBe('Story');
        expect(stripDesTrackerJson('{"quests": [1,], }\nStory')).toBe('Story');
    });

    it('keeps other code blocks, JSON and text', () => {
        const code = '```json\n{"name":"not a tracker"}\n```\nStory';
        expect(stripDesTrackerJson(code)).toBe(code);
        const js = '```js\nconst a = 1;\n```\nStory';
        expect(stripDesTrackerJson(js)).toBe(js);
        expect(stripDesTrackerJson('{"name":"x"} story')).toBe('{"name":"x"} story');
        expect(stripDesTrackerJson('{unbalanced')).toBe('{unbalanced');
        expect(stripDesTrackerJson('Just a story.')).toBe('Just a story.');
        expect(stripDesTrackerJson(`Story first.\n\`\`\`json\n${TRACKER}\n\`\`\``)).toContain('Story first.');
        expect(stripDesTrackerJson('```json\n[1, 2]\n```\nStory')).toContain('[1, 2]');
    });

    it('tolerates empty and non-string input', () => {
        expect(stripDesTrackerJson('')).toBe('');
        expect(stripDesTrackerJson('   ')).toBe('   ');
        expect(stripDesTrackerJson(undefined as unknown as string)).toBe('');
    });
});

describe('stripHtml', () => {
    it('removes real HTML tags, comments, style and script blocks; block tags become line breaks', () => {
        const html =
            '<div class="a">One<br>Two</div><!-- note --><style>.x{color:red}</style><script>alert(1)</script><font color="red">Three</font>';
        expect(stripHtml(html)).toBe('\nOne\nTwo\nThree');
    });

    it('handles upper-case HTML and self-closing tags', () => {
        expect(stripHtml('<B>bold</B> <img src="x.png"/> <HR>')).toBe('bold  \n');
    });

    it('keeps BunnyMo tags that only look like tags', () => {
        const text = '<SPECIES:ELF> <PHYSICAL> <STYLE:GOTHIC> <Name:Lira> <INTJ-U> </PHYSICAL>';
        expect(stripHtml(text)).toBe(text);
    });

    it('decodes entities', () => {
        expect(stripHtml('a &lt;b&gt; &amp;amp; &quot;q&quot; &#39;s&#39; &#x41;&nbsp;&unknown; &#0;')).toBe(
            'a <b> &amp; "q" \'s\' A &unknown; &#0;',
        );
    });

    it('keeps plain text and custom elements are removed', () => {
        expect(stripHtml('plain')).toBe('plain');
        expect(stripHtml('<my-widget data-x="1">in</my-widget>')).toBe('in');
        expect(stripHtml(42 as unknown as string)).toBe('');
    });
});

describe('isHtmlElementName', () => {
    it('knows HTML names in any case and custom elements', () => {
        expect(isHtmlElementName('DIV')).toBe(true);
        expect(isHtmlElementName('br')).toBe(true);
        expect(isHtmlElementName('x-card')).toBe(true);
        expect(isHtmlElementName('PHYSICAL')).toBe(false);
        expect(isHtmlElementName('NSFW')).toBe(false);
    });
});

describe('stripCkDumps', () => {
    const dump = '<BunnyMoTags>\nLira:\n• SPECIES: elf\n• TRAIT: stoic, kind\n\nAtsu:\n</BunnyMoTags>';

    it('removes CK thinking-mode dumps with the blank lines before them', () => {
        expect(stripCkDumps(`Lira nods.\n\n${dump}`)).toBe('Lira nods.');
    });

    it('keeps sheets with <KEY:VALUE> tags and other wrappers', () => {
        const sheet = 'Sheet\n<BunnyMoTags><Name:Lira>, <SPECIES:ELF></BunnyMoTags>';
        expect(stripCkDumps(sheet)).toBe(sheet);
        const archive = '<BunnymoTags>\nLira:\n</BunnymoTags>';
        expect(stripCkDumps(archive)).toBe(archive);
        const prose = '<BunnyMoTags>\nfree text\n</BunnyMoTags>';
        expect(stripCkDumps(prose)).toBe(prose);
    });

    it('tolerates text without dumps and non-strings', () => {
        expect(stripCkDumps('nothing')).toBe('nothing');
        expect(stripCkDumps(null as unknown as string)).toBe('');
    });

    it('recognises dump bodies', () => {
        expect(isCkDumpBody('Lira:\n• A: b')).toBe(true);
        expect(isCkDumpBody('Lira:')).toBe(true);
        expect(isCkDumpBody('')).toBe(false);
        expect(isCkDumpBody('<A:B>')).toBe(false);
        expect(isCkDumpBody('free text')).toBe(false);
    });
});

describe('stripNaiPlaceholders', () => {
    it('removes inline image placeholders with surrounding spaces', () => {
        expect(stripNaiPlaceholders('Before [nai:img:abc123-xyz] after')).toBe('Before after');
        expect(stripNaiPlaceholders('[nai:img:abcdef]\nText')).toBe('\nText');
        expect(stripNaiPlaceholders('Text [nai:img:abcdef]')).toBe('Text');
        expect(stripNaiPlaceholders('Text\n  [nai:img:abcdef]  \nMore')).toBe('Text\n\nMore');
        expect(stripNaiPlaceholders('no images')).toBe('no images');
        expect(stripNaiPlaceholders(undefined as unknown as string)).toBe('');
    });
});

describe('isImagePost', () => {
    const naiMedia = (title: string, prompt = 'tags') => ({
        url: 'x.png',
        type: 'image',
        title,
        source: 'generated',
        nai_studio: { seed: 1, prompt },
    });

    it('detects NAI Studio picture posts by extra.nai_studio', () => {
        expect(isImagePost({ mes: 'a girl', extra: { nai_studio: { model: 'nai' }, media: [] } })).toBe(true);
    });

    it('detects galleries of NAI images whose text is empty or the image prompt', () => {
        expect(isImagePost({ mes: '', extra: { media: [naiMedia('scene')] } })).toBe(true);
        expect(isImagePost({ mes: 'scene', extra: { media: [naiMedia('scene')] } })).toBe(true);
        expect(isImagePost({ mes: 'tags', extra: { media: [naiMedia('other', 'tags')] } })).toBe(true);
    });

    it('does not take illustrated story messages or other media for picture posts', () => {
        expect(isImagePost({ mes: 'A long story reply.', extra: { media: [naiMedia('scene')] } })).toBe(false);
        expect(isImagePost({ mes: '', extra: { media: [{ url: 'u.png', type: 'image' }] } })).toBe(false);
        expect(isImagePost({ mes: '', extra: { media: [] } })).toBe(false);
        expect(isImagePost({ mes: 'text', extra: {} })).toBe(false);
        expect(isImagePost({ mes: 'text' })).toBe(false);
        expect(isImagePost(null)).toBe(false);
    });
});

describe('cleanForAnalysis', () => {
    it('combines every cleaner and tidies whitespace', () => {
        const mes = [
            '```json',
            TRACKER,
            '```',
            '<p>Lira   draws her sword.</p>   ',
            '',
            '',
            '',
            '[nai:img:abcdef12] "Run!" &mdash; she says.',
            '',
            '<BunnyMoTags>\nLira:\n• TRAIT: brave\n</BunnyMoTags>',
        ].join('\n');
        expect(cleanForAnalysis({ mes, extra: {} })).toBe('Lira   draws her sword.\n\n"Run!" &mdash; she says.');
    });

    it('returns empty text for picture posts and messages without text', () => {
        expect(cleanForAnalysis({ mes: 'tags', extra: { nai_studio: {} } })).toBe('');
        expect(cleanForAnalysis({ extra: {} })).toBe('');
        expect(cleanForAnalysis(null)).toBe('');
    });

    it('accepts a raw string', () => {
        expect(cleanForAnalysis('<b>Hi</b>\r\nthere ')).toBe('Hi\nthere');
    });

    it('drops a mechanics service block the mechanics module has not stripped yet', () => {
        const mes = 'Лира колдует.\n\n<mechanics>\nЛира.Mana: -10\n</mechanics>';
        expect(cleanForAnalysis({ mes, extra: {} })).toBe('Лира колдует.');
    });
});
