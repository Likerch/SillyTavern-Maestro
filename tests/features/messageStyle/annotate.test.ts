// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { buildPlan, makeStyle, presetRules } from '../../../src/domain/message-style';
import type { MatchKind, ScopePlan, StyleRule } from '../../../src/domain/message-style';
import { sampleHtml } from '../../../src/domain/message-style-model';
import {
    annotateHtml,
    annotateNode,
    clearAnnotations,
    hasAnnotations,
} from '../../../src/features/messageStyle/annotate';

function rule(id: string, kind: MatchKind, extra: Partial<StyleRule> = {}): StyleRule {
    return { id, name: '', enabled: true, match: { kind }, applyTo: 'all', style: makeStyle(), ...extra };
}

const plan = (...rules: StyleRule[]): ScopePlan => buildPlan(rules, 'char');

function box(html: string): HTMLElement {
    const node = document.createElement('div');
    node.innerHTML = html;
    document.body.appendChild(node);
    return node;
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('annotateNode', () => {
    it('classifies ST quotes and wraps swappable marks', () => {
        const node = box('<p><q>"Да"</q> и <q>«Нет»</q> и <q>「x」</q></p>');
        const count = annotateNode(
            node,
            plan(rule('dq', 'doubleQuotes', { style: makeStyle({ marks: 'guillemets' }) }), rule('gq', 'guillemets')),
        );
        expect(count).toBe(4);
        expect(node.innerHTML).toBe(
            '<p><q class="maestro-ms-dq"><span class="maestro-ms-mark">"</span>Да<span class="maestro-ms-mark">"</span></q> и <q class="maestro-ms-gq">«Нет»</q> и <q>「x」</q></p>',
        );
    });

    it('wraps dash dialogue in one span when it stays in one element, with its mark', () => {
        const node = box('<p>— Ну <em>что</em> ты, — сказал он.<br>Тихо. — Да.</p>');
        annotateNode(node, plan(rule('d', 'dashDialogue', { style: makeStyle({ marks: 'straight' }) })));
        expect(node.innerHTML).toBe(
            '<p><span class="maestro-ms-dash"><span class="maestro-ms-mark">— </span>Ну <em>что</em> ты</span>, — сказал он.<br>Тихо. <span class="maestro-ms-dash"><span class="maestro-ms-mark">— </span>Да.</span></p>',
        );
        expect(node.textContent).toBe('— Ну что ты, — сказал он.Тихо. — Да.');
    });

    it('wraps piece by piece when a match leaves an element, skipping quotes and code', () => {
        const node = box('<p><em>— Привет</em> <q>"друг"</q> <code>x</code>, — сказал он.</p>');
        annotateNode(node, plan(rule('d', 'dashDialogue')));
        expect(node.innerHTML).toBe(
            '<p><em><span class="maestro-ms-dash">— Привет</span></em><span class="maestro-ms-dash"> </span><q>"друг"</q><span class="maestro-ms-dash"> </span><code>x</code>, — сказал он.</p>',
        );
    });

    it('marks asides and custom rules, never inside links, code or NAI images', () => {
        const custom = rule('c1', 'custom', { match: { kind: 'custom', pattern: '~[^~]+~' } });
        const node = box(
            '<p>(тихо) [пометка] ~шёпот~ <a href="https://x">(ссылка)</a> <code>[код]</code> <span data-naist-img="a">[x]</span></p>',
        );
        annotateNode(node, plan(rule('p', 'parentheses'), rule('b', 'brackets'), custom));
        expect(node.innerHTML).toBe(
            '<p><span class="maestro-ms-paren">(тихо)</span> <span class="maestro-ms-bracket">[пометка]</span> <span class="maestro-ms-c-c1">~шёпот~</span> <a href="https://x">(ссылка)</a> <code>[код]</code> <span data-naist-img="a">[x]</span></p>',
        );
    });

    it('leaves the DES tracker JSON and URLs alone', () => {
        const node = box(
            '<p>{<q>"infoBox"</q>: {<q>"location"</q>: <q>"Дом"</q>}}</p><p>(см. https://a.b/(c)) <q>"Да"</q></p>',
        );
        annotateNode(node, plan(rule('q', 'doubleQuotes'), rule('p', 'parentheses')));
        expect(node.querySelectorAll('.maestro-ms-dq')).toHaveLength(1);
        expect(node.querySelector('.maestro-ms-paren')?.textContent).toBe('(см. https://a.b/(c))');
    });

    it('returns 0 and changes nothing for an empty plan or plain text', () => {
        const node = box('<p>Просто текст.</p>');
        expect(annotateNode(node, plan(rule('d', 'dashDialogue')))).toBe(0);
        expect(annotateNode(node, plan())).toBe(0);
        expect(node.innerHTML).toBe('<p>Просто текст.</p>');
    });
});

describe('clearAnnotations', () => {
    it('restores the original markup, sanitized classes included', () => {
        const original = '<p>— Ну <em>что</em> ты, — сказал он. <q>"Да"</q> (а)</p>';
        const node = box(original);
        const rules = presetRules('guillemets');
        rules.push(rule('p', 'parentheses'));
        annotateNode(node, buildPlan(rules, 'char'));
        expect(hasAnnotations(node)).toBe(true);
        expect(clearAnnotations(node)).toBeGreaterThan(0);
        expect(node.innerHTML).toBe(original);
        expect(node.childNodes[0]!.childNodes).toHaveLength(5);
        expect(hasAnnotations(node)).toBe(false);

        const sanitized = box(
            '<p><span class="custom-maestro-ms-dash">— Да</span> <q class="custom-maestro-ms-dq x">"Нет"</q></p>',
        );
        clearAnnotations(sanitized);
        expect(sanitized.innerHTML).toBe('<p>— Да <q class="x">"Нет"</q></p>');
    });

    it('is idempotent with annotateNode (clear, then mark again)', () => {
        const node = box('<p>— Раз, — два. — Три.</p>');
        const current = plan(rule('d', 'dashDialogue'));
        annotateNode(node, current);
        const first = node.innerHTML;
        clearAnnotations(node);
        annotateNode(node, current);
        expect(node.innerHTML).toBe(first);
    });
});

describe('annotateHtml', () => {
    it('marks ST HTML through an inert template', () => {
        const html = '<p>— Да, — сказал он.</p>\n<p><img src="x.png" onerror="window.hit = 1"></p>';
        const out = annotateHtml(html, plan(rule('d', 'dashDialogue')), document);
        expect(out).toContain('<span class="maestro-ms-dash">— Да</span>');
        expect((window as unknown as { hit?: number }).hit).toBeUndefined();
    });

    it('returns the very same string when nothing is marked', () => {
        const html = '<p>Без диалогов &amp; скобок</p>';
        expect(annotateHtml(html, plan(rule('d', 'dashDialogue')), document)).toBe(html);
        expect(annotateHtml('<p>— нет тире-реплик? нет: a — b</p>', plan(rule('p', 'parentheses')), document)).toBe(
            '<p>— нет тире-реплик? нет: a — b</p>',
        );
    });

    it('marks the preview fallback the same way', () => {
        const html = sampleHtml('"Да" — сказал он. *Мысль*');
        const out = annotateHtml(html, plan(rule('q', 'doubleQuotes')), document);
        expect(out).toBe('<p><q class="maestro-ms-dq">"Да"</q> — сказал он. <em>Мысль</em></p>');
    });
});
