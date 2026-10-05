// @vitest-environment happy-dom
// Wiring of the real module: the neighbours' skins (part B) and their strings are registered with the layer.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_TOKENS, themeModule } from '../../../src/features/theme';
import { NEIGHBOUR_SKINS } from '../../../src/features/theme/neighbours';
import { NEIGHBOUR_PARTS } from '../../../src/features/theme/settings';

/** Tokens Maestro's own stylesheet defines on :root (src/ui/style.css). */
const coreTokens = new Set(
    [...readFileSync('src/ui/style.css', 'utf8').matchAll(/^\s*(--maestro-[a-z0-9-]+)\s*:/gm)].map((match) => match[1]),
);

describe('themeModule', () => {
    it('is M32 «theme» of stage 12, on by default, with defaults for every part', () => {
        expect(themeModule).toMatchObject({ id: 'M32', key: 'theme', stage: 12, enabledByDefault: true });
        expect(Object.keys(themeModule.defaults().parts)).toEqual(['st', 'chat', ...NEIGHBOUR_PARTS]);
    });

    it('registers a translated name for every neighbour skin', () => {
        const i18n = themeModule.i18n!;
        expect(NEIGHBOUR_SKINS.length).toBeGreaterThan(0);
        for (const skin of NEIGHBOUR_SKINS) {
            expect(NEIGHBOUR_PARTS).toContain(skin.id);
            expect(i18n.en[skin.titleKey]).toBeTruthy();
            expect(i18n.ru[skin.titleKey]).toBeTruthy();
        }
        expect(Object.keys(i18n.ru).sort()).toEqual(Object.keys(i18n.en).sort());
    });

    it('skins use only tokens the layer or Maestro’s own UI define', () => {
        for (const skin of NEIGHBOUR_SKINS) {
            const used = new Set([...skin.css.matchAll(/var\((--maestro-[a-z0-9-]+)/g)].map((match) => match[1]));
            for (const name of used) {
                expect(THEME_TOKENS.includes(name!) || coreTokens.has(name!), `${skin.id}: ${name}`).toBe(true);
            }
        }
    });
});
