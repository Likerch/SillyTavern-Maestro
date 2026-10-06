// Strings of M25 part C: both languages carry the same keys, every key the code asks for exists, and the Russian
// texts are Russian.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHECK_STRINGS } from '../../../src/features/mechanics/strings-checks';

const SOURCES = ['checks.ts', 'prompt.ts', 'widgets.ts'].map((name) =>
    readFileSync(new URL(`../../../src/features/mechanics/${name}`, import.meta.url), 'utf8'),
);

describe('CHECK_STRINGS', () => {
    it('has the same keys in English and Russian, all of this part', () => {
        expect(Object.keys(CHECK_STRINGS.ru).sort()).toEqual(Object.keys(CHECK_STRINGS.en).sort());
        for (const key of Object.keys(CHECK_STRINGS.en)) {
            expect(key).toMatch(/^(m25\.(check|widget|prompt)\.|kind\.mechanics\.check$)/);
            expect(CHECK_STRINGS.en[key]?.trim()).toBeTruthy();
            expect(CHECK_STRINGS.ru[key]?.trim()).toBeTruthy();
        }
    });

    it('covers every key the code uses', () => {
        const used = new Set<string>();
        for (const source of SOURCES) {
            for (const match of source.matchAll(/'(m25\.(?:check|widget|prompt)\.[\w.]+)'/g)) used.add(match[1]!);
        }
        for (const outcome of ['critical', 'success', 'failure', 'fumble', 'none'])
            used.add(`m25.check.outcome.${outcome}`);
        for (const by of ['auto', 'user', 'model']) used.add(`m25.check.by.${by}`);
        for (const source of ['desStats', 'block', 'background', 'check', 'event', 'user', 'time']) {
            used.add(`m25.widget.source.${source}`);
        }
        expect(used.size).toBeGreaterThan(30);
        for (const key of used) expect(CHECK_STRINGS.en, key).toHaveProperty([key]);
    });

    it('keeps the placeholders of every text in both languages', () => {
        const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const [key, text] of Object.entries(CHECK_STRINGS.en)) {
            expect(names(CHECK_STRINGS.ru[key] ?? ''), key).toEqual(names(text));
        }
    });

    it('Russian texts are Russian', () => {
        const russian = Object.entries(CHECK_STRINGS.ru).filter(([, text]) => /[а-яё]/i.test(text));
        expect(russian.length).toBeGreaterThan(Object.keys(CHECK_STRINGS.ru).length - 8);
    });
});
