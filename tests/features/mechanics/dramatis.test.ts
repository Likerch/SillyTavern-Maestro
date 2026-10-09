// @vitest-environment happy-dom
// M25 with Dramatis (release 1.17): while Dramatis keeps attitudes and social standing itself, the «relationships» and
// «social» templates leave the picker and the service's list; mechanics made from them stay and get a note.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_TEMPLATES, engineReplacesSocial, offeredTemplates } from '../../../src/features/mechanics/dramatis';
import type { ChecksPart, StatePart } from '../../../src/features/mechanics/parts';
import { MechanicsService } from '../../../src/features/mechanics/service';
import { constructorSection } from '../../../src/features/mechanics/view-constructor';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { installDramatis } from '../../helpers/dramatis';
import type { InstalledDramatis } from '../../helpers/dramatis';
import { BOOK, createDefsEnv, FakeDefs, FakeTracking, mechanic } from './helpers-defs';
import type { DefsEnv } from './helpers-defs';

let env: DefsEnv;
let defs: FakeDefs;
let dramatis: InstalledDramatis;
let container: HTMLElement;
let unmount: Unsubscribe | void;

beforeEach(() => {
    env = createDefsEnv();
    defs = new FakeDefs();
    dramatis = installDramatis(env.app);
    container = document.createElement('div');
    document.body.replaceChildren(container);
});

afterEach(() => {
    if (typeof unmount === 'function') unmount();
    unmount = undefined;
    dramatis.remove();
});

const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};

function templateTitles(): string[] {
    return [...container.querySelectorAll('.maestro-m25-template .maestro-card-title')].map(
        (node) => node.textContent ?? '',
    );
}

async function openTemplates(): Promise<void> {
    unmount = constructorSection(env.deps, defs, new FakeTracking())(container);
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === 'From a template',
    );
    button?.click();
    await settle();
}

describe('M25 with Dramatis', () => {
    it('knows the templates Dramatis replaces and when it does', () => {
        expect([...ENGINE_TEMPLATES]).toEqual(['relationships', 'social']);
        expect(engineReplacesSocial(env.app)).toBe(false);
        dramatis.api.replaces = true;
        expect(engineReplacesSocial(env.app)).toBe(true);
        expect(offeredTemplates(env.app, [{ id: 'health' }, { id: 'social' }])).toEqual([{ id: 'health' }]);
        dramatis.remove();
        expect(engineReplacesSocial(env.app)).toBe(false);
    });

    it('hides the social templates in the picker only while Dramatis replaces them', async () => {
        await openTemplates();
        expect(templateTitles()).toContain('Relationships');
        expect(templateTitles()).toContain('Social scales');
        if (typeof unmount === 'function') unmount();

        dramatis.api.replaces = true;
        container.replaceChildren();
        await openTemplates();
        expect(templateTitles()).not.toContain('Relationships');
        expect(templateTitles()).not.toContain('Social scales');
        expect(templateTitles()).toContain('Health and stamina');
    });

    it('keeps a mechanic made from them, with a note', async () => {
        dramatis.api.replaces = true;
        defs.defs = [
            { ...mechanic({ id: 'trust', name: 'Доверие', template: 'social' }), book: BOOK, uid: 1 },
            { ...mechanic({ id: 'magic' }), book: BOOK, uid: 2 },
        ];
        unmount = constructorSection(env.deps, defs, new FakeTracking())(container);
        const cards = [...container.querySelectorAll('.maestro-m25-def')];
        expect(cards).toHaveLength(2);
        expect(cards[0]?.textContent).toContain('Dramatis now keeps attitudes and social standing itself');
        expect(cards[1]?.textContent).not.toContain('Dramatis');
    });

    it('leaves them out of the service’s template list too', () => {
        const service = new MechanicsService(defs, {} as StatePart, {} as ChecksPart, env.deps);
        expect(service.templates().map((item) => item.id)).toContain('social');
        dramatis.api.replaces = true;
        expect(service.templates().map((item) => item.id)).not.toContain('social');
        expect(service.templates().map((item) => item.id)).not.toContain('relationships');
        // An explicit request still works (the assistant, an import).
        expect(service.fromTemplate('social')?.template).toBe('social');
    });
});
