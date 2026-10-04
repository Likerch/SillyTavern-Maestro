// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DossierOpener } from '../../../src/features/dossier/opener';
import { defaultDossierSettings } from '../../../src/features/dossier/settings';
import { DossierSources } from '../../../src/features/dossier/sources';
import { LYRA_ID, lyraScene } from './fixtures';
import { createDossierEnv, passport } from './helpers';
import type { DossierEnv } from './helpers';

let env: DossierEnv;
let sources: DossierSources;
let opener: DossierOpener;

beforeEach(() => {
    env = createDossierEnv();
    lyraScene(env);
    sources = new DossierSources(env.app, defaultDossierSettings, env.log);
    opener = new DossierOpener(env.app, env.log);
});

const lore = { source: { kind: 'lore.entry' as const, ref: 'World#1', label: 'Lyra', world: 'World', uid: 1 } };

describe('DossierOpener', () => {
    it('prefers the Lore Studio API, then /maestro-lore, then the classic editor', async () => {
        const open = vi.fn();
        env.modules.expose('loreStudio', { open });
        await opener.open(lore);
        expect(open).toHaveBeenCalledWith('World', 1);
        env.modules.apis.delete('loreStudio');
        env.modules.expose('loreStore', {});
        await opener.open(lore);
        expect(env.slashRuns).toEqual(['/maestro-lore World']);
        env.modules.apis.delete('loreStore');
        await opener.open(lore);
        expect(env.world.opened).toEqual(['World']);
        expect(env.closed).toBe(3);
    });

    it('jumps to messages and opens places; passports have no link (NAI Studio API v1 cannot open one)', async () => {
        expect(opener.canOpen({ messageIndex: 4 })).toBe(true);
        await opener.open({ messageIndex: 4 });
        expect(env.slashRuns).toEqual(['/chat-jump 4']);
        const placeSource = { source: { kind: 'place' as const, ref: 'tavern', label: 'Таверна' } };
        expect(opener.canOpen(placeSource)).toBe(true);
        await opener.open(placeSource);
        expect(env.opened).toEqual(['places']);
        const naiSource = { kind: 'nai.passport' as const, ref: 'lyra.png#p1', label: 'Лира', passportId: 'p1' };
        expect(opener.canOpen({ source: naiSource })).toBe(false);
        expect(opener.canOpen({ source: { kind: 'card', ref: 'lyra.png', label: 'Лира' } })).toBe(false);
        expect(opener.canOpen({})).toBe(false);
    });
});

describe('NAI chat-level passports', () => {
    function override(fields: Record<string, unknown>, extra: unknown[] = []): void {
        env.mock.chatMetadata = { nai_studio: { passports: { overrides: { p1: fields }, extra } } };
    }

    it('applies an override only for its owner and shows base and override', async () => {
        override({ owner: 'other.png', slots: { eyes: 'red eyes' } });
        let facts = await sources.facts(sources.entity(LYRA_ID)!);
        expect(facts.passports[0]?.chat).toBeNull();
        override({ slots: { eyes: 'red eyes' }, activeOutfit: '' });
        facts = await sources.facts(sources.entity(LYRA_ID)!);
        expect(facts.passports[0]?.chat).toEqual({ slots: { eyes: 'red eyes' }, activeOutfit: '' });
        env.mock.chatMetadata = {};
        facts = await sources.facts(sources.entity(LYRA_ID)!);
        expect(facts.passports[0]?.chat).toBeNull();
        expect(facts.naiApi).toBe(true);
    });

    it('lists the chat’s own passports from the API or, without it, from the chat metadata', async () => {
        env.n.desKnown = ['Лира', 'Мара'];
        const mara = passport({ id: 'npc1', name: 'Мара', slots: { hair: 'red hair' } });
        override({ owner: 'lyra.png' }, [mara, { id: 'npc2', name: '' }]);
        let facts = await sources.facts(sources.entity('character:мара')!);
        expect(facts.passports.map((item) => [item.level, item.passport.id])).toEqual([['chat', 'npc1']]);
        env.n.naiApi = undefined;
        facts = await sources.facts(sources.entity('character:мара')!);
        expect(facts.passports.map((item) => [item.level, item.passport.id])).toEqual([['chat', 'npc1']]);
        expect(facts.naiApi).toBe(false);
    });

    it('reads the persona override by its owner', async () => {
        env.host.modules.load = async () => ({ user_avatar: 'alex.png' });
        env.n.naiSettings = {
            scene: { personaPassports: { 'alex.png': passport({ id: 'pp', slots: { hair: 'black hair' } }) } },
        };
        env.mock.chatMetadata = {
            nai_studio: {
                passports: { overrides: { pp: { owner: 'persona:alex.png', slots: { hair: 'grey hair' } } } },
            },
        };
        const facts = await sources.facts(sources.entity('persona:алекс')!);
        expect(facts.passports[0]).toMatchObject({ level: 'persona', chat: { slots: { hair: 'grey hair' } } });
    });

    it('survives neighbours that throw', async () => {
        const broken = env.app.adapters as unknown as Record<string, Record<string, unknown>>;
        broken.des!.knownCharacters = () => {
            throw new Error('boom');
        };
        broken.nai!.passportsOf = () => {
            throw new Error('boom');
        };
        const facts = await sources.facts(sources.entity(LYRA_ID)!);
        expect(facts.passports).toEqual([]);
        expect(facts.lore).toHaveLength(1);
    });
});
