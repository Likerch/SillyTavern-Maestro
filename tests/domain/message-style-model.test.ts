import { describe, expect, it } from 'vitest';
import { buildPlan, makeStyle } from '../../src/domain/message-style';
import type { MatchKind, ScopePlan, StyleRule } from '../../src/domain/message-style';
import { MASK_EXCLUDED, MASK_OPAQUE } from '../../src/domain/message-style-match';
import {
    VisibleTextBuilder,
    isWhole,
    mayAnnotate,
    pieceRuns,
    planAnnotations,
    sampleHtml,
} from '../../src/domain/message-style-model';
import type { VisibleText } from '../../src/domain/message-style-model';

function rule(id: string, kind: MatchKind, extra: Partial<StyleRule> = {}): StyleRule {
    return { id, name: '', enabled: true, match: { kind }, applyTo: 'all', style: makeStyle(), ...extra };
}

const plan = (...rules: StyleRule[]): ScopePlan => buildPlan(rules, 'char');

type Node = string | [string, Node[]] | [string, Node[], { skip?: boolean }];

/** Builds a model from a tiny tree: strings are text pieces, [name, children] elements. */
function model(nodes: Node[]): VisibleText {
    const builder = new VisibleTextBuilder();
    let piece = 0;
    const visit = (list: Node[]) => {
        for (const node of list) {
            if (typeof node === 'string') {
                builder.text(node, piece++);
            } else {
                const id = builder.open(node[0], node[2]);
                visit(node[1]);
                builder.close(id);
            }
        }
    };
    visit(nodes);
    return builder.build();
}

describe('VisibleTextBuilder', () => {
    it('adds paragraph and line breaks for blocks and <br>, and collapses whitespace', () => {
        const visible = model([['p', ['a\nb']], '\n', ['p', ['c', ['br', []], 'd']], ['DIV', ['e']]]);
        expect(visible.text).toBe('a b\n\n \n\nc\nd\n\ne\n\n');
        expect(visible.piece[0]).toBe(0);
        expect(visible.piece[3]).toBe(-1);
    });

    it('masks excluded content and makes quote content opaque', () => {
        const visible = model([
            ['p', ['x ', ['code', ['(a)']], ' ', ['q', ['"y"']], ' ', ['span', ['[z]'], { skip: true }]]],
        ]);
        const at = (char: string) => visible.mask[visible.text.indexOf(char)];
        expect(at('x')).toBe(0);
        expect(at('a')).toBe(MASK_EXCLUDED);
        expect(at('y')).toBe(MASK_OPAQUE);
        expect(at('z')).toBe(MASK_EXCLUDED);
        expect(visible.quotes).toEqual([{ element: 2, first: 6, last: 8 }]);
    });

    it('applies text exclusions (URLs, NAI markers) to the visible text', () => {
        const visible = model([['p', ['see https://a.b/(c) [nai:img:x1]']]]);
        expect(visible.mask[visible.text.indexOf('https')]).toBe(MASK_EXCLUDED);
        expect(visible.mask[visible.text.indexOf('[nai')]).toBe(MASK_EXCLUDED);
        expect(visible.mask[0]).toBe(0);
    });

    it('ignores a close of an element that is not the innermost and empty text', () => {
        const builder = new VisibleTextBuilder();
        const outer = builder.open('p');
        const inner = builder.open('em');
        builder.close(outer);
        builder.text('', 0);
        builder.text('a', 1);
        builder.close(inner);
        builder.close(outer);
        const visible = builder.build();
        expect(visible.text).toBe('a\n\n');
        expect(visible.parent[0]).toBe(inner);
        expect(visible.depth[0]).toBe(2);
    });
});

describe('isWhole and pieceRuns', () => {
    it('is whole only when start and end share an element', () => {
        const visible = model([['p', ['— Ну ', ['em', ['что']], ' ты.']]]);
        expect(isWhole(visible, 0, visible.text.indexOf('.') + 1)).toBe(true);
        expect(isWhole(visible, visible.text.indexOf('ч'), visible.text.indexOf('.') + 1)).toBe(false);
        expect(isWhole(visible, 0, 0)).toBe(false);
        expect(isWhole(visible, 0, visible.text.length)).toBe(false);
    });

    it('cuts runs at pieces, masks and virtual characters', () => {
        const visible = model([
            ['p', ['ab', ['q', ['"c"']], 'de']],
            ['p', ['f']],
        ]);
        expect(pieceRuns(visible, 0, visible.text.length)).toEqual([
            { start: 0, end: 2 },
            { start: 5, end: 7 },
            { start: 9, end: 10 },
        ]);
    });
});

describe('planAnnotations', () => {
    it('classifies quotes and wraps their marks only when asked', () => {
        const visible = model([
            [
                'p',
                [
                    ['q', ['"a"']],
                    ' ',
                    ['q', ['«b»']],
                    ' ',
                    ['q', ['“c']],
                    ' ',
                    ['q', ['「d」']],
                    ' ',
                    ['q', ['"', ['em', ['e']], '"']],
                ],
            ],
        ]);
        const swapped = planAnnotations(
            visible,
            plan(rule('q', 'doubleQuotes', { style: makeStyle({ marks: 'none' }) }), rule('g', 'guillemets')),
        );
        expect(swapped.map((item) => (item.type === 'quote' ? [item.cls, item.marks.length] : null))).toEqual([
            ['dq', 2],
            ['gq', 0],
            ['dq', 0],
            ['dq', 2],
        ]);
        expect(planAnnotations(visible, plan(rule('a', 'asterisk')))).toEqual([]);
    });

    it('skips quotes inside the DES tracker JSON', () => {
        const visible = model([
            ['p', ['{', ['q', ['"infoBox"']], ': {', ['q', ['"location"']], ': 1}}']],
            ['p', [['q', ['"Да"']]]],
        ]);
        const marks = planAnnotations(visible, plan(rule('q', 'doubleQuotes')));
        expect(marks).toHaveLength(1);
    });

    it('wraps dash speech whole or in pieces, with its mark when asked', () => {
        const whole = model([['p', ['— Да, — сказал он.']]]);
        expect(
            planAnnotations(whole, plan(rule('d', 'dashDialogue', { style: makeStyle({ marks: 'straight' }) }))),
        ).toEqual([
            { type: 'span', cls: 'dash', start: 0, end: 4, whole: true, pieces: [], marks: [{ start: 0, end: 2 }] },
        ]);
        const inside = model([['p', [['em', ['— Да']], ', — сказал он.']]]);
        expect(planAnnotations(inside, plan(rule('d', 'dashDialogue')))[0]).toMatchObject({ whole: true, end: 4 });
        const split = model([['p', [['em', ['— Да']], ' нет, — сказал он.']]]);
        const [span] = planAnnotations(
            split,
            plan(rule('d', 'dashDialogue', { style: makeStyle({ marks: 'curly' }) })),
        );
        expect(span).toMatchObject({
            whole: false,
            pieces: [
                { start: 0, end: 4 },
                { start: 4, end: 8 },
            ],
            marks: [{ start: 0, end: 2 }],
        });
        const dashInElement = model([['p', [['b', ['—']], ' Да.']]]);
        const [broken] = planAnnotations(
            dashInElement,
            plan(rule('d', 'dashDialogue', { style: makeStyle({ marks: 'curly' }) })),
        );
        expect(broken).toMatchObject({ whole: false, marks: [] });
    });

    it('wraps only plain text when a match spans several elements', () => {
        const visible = model([
            [
                'p',
                [
                    ['em', ['(']],
                    ['code', ['x']],
                    ['b', [')']],
                ],
            ],
        ]);
        expect(planAnnotations(visible, plan(rule('p', 'parentheses')))).toEqual([
            {
                type: 'span',
                cls: 'paren',
                start: 0,
                end: 3,
                whole: false,
                pieces: [
                    { start: 0, end: 1 },
                    { start: 2, end: 3 },
                ],
                marks: [],
            },
        ]);
    });

    it('marks custom rules and asides by rule order', () => {
        const visible = model([['p', ['~(a)~ [b]']]]);
        const custom = rule('c1', 'custom', { match: { kind: 'custom', pattern: '~[^~]+~' } });
        expect(
            planAnnotations(visible, plan(custom, rule('p', 'parentheses'), rule('b', 'brackets'))).map((item) =>
                item.type === 'span' ? item.cls : item.type,
            ),
        ).toEqual(['c-c1', 'bracket']);
        expect(
            planAnnotations(visible, plan(rule('p', 'parentheses'), custom)).map((item) =>
                item.type === 'span' ? item.cls : item.type,
            ),
        ).toEqual(['c-c1']);
        const broken: ScopePlan = {
            quotes: false,
            marks: { dq: false, gq: false, dash: false },
            spans: [{ cls: 'c-x', kind: 'custom', pattern: '(' }],
        };
        expect(planAnnotations(visible, broken)).toEqual([]);
    });
});

describe('mayAnnotate', () => {
    it('is a cheap pre-check per kind', () => {
        const dash = plan(rule('d', 'dashDialogue'));
        expect(mayAnnotate('', dash)).toBe(false);
        expect(mayAnnotate('<p>— Да</p>', dash)).toBe(true);
        expect(mayAnnotate('<p>&mdash; Да</p>', dash)).toBe(true);
        expect(mayAnnotate('<p>Да</p>', dash)).toBe(false);
        expect(mayAnnotate('<p><q>"a"</q></p>', plan(rule('q', 'doubleQuotes')))).toBe(true);
        expect(mayAnnotate('<p>(a)</p>', plan(rule('p', 'parentheses')))).toBe(true);
        expect(mayAnnotate('<p>[a]</p>', plan(rule('b', 'brackets')))).toBe(true);
        expect(mayAnnotate('<p>a</p>', plan(rule('c', 'custom', { match: { kind: 'custom', pattern: 'a' } })))).toBe(
            true,
        );
        expect(mayAnnotate('<p>a</p>', plan(rule('b', 'brackets')))).toBe(false);
    });
});

describe('sampleHtml', () => {
    it('renders text the way ST does, escaped', () => {
        expect(sampleHtml('"Да" *мысль* **акцент** `x<y`\n«Нет» _тихо_ & <b>\n\nВторой')).toBe(
            '<p><q>"Да"</q> <em>мысль</em> <strong>акцент</strong> <code>x&lt;y</code><br><q>«Нет»</q> <em>тихо</em> &amp; &lt;b&gt;</p><p>Второй</p>',
        );
        expect(sampleHtml('***оба*** "в *нём*"')).toBe('<p><em><strong>оба</strong></em> <q>"в <em>нём</em>"</q></p>');
        expect(sampleHtml('')).toBe('');
    });
});
