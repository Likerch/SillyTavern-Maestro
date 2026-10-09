// @vitest-environment happy-dom
// «Подготовить к игре» and Dramatis 1.3 (release 1.19): applying has Dramatis read the card's intent (by default only
// when it has not read this card; again on request, with force), and «Итог» says what Dramatis has — read now, already
// there, or why not — with «Открыть»; the saved preparation never asks Dramatis to read; an older Dramatis, or none,
// changes nothing.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createI18n } from '../../../src/core/i18n';
import { CORE_STRINGS } from '../../../src/core/strings';
import { DRAMATIS_ITEM, DramatisStep } from '../../../src/features/prepare/dramatis-step';
import { PREPARE_STRINGS } from '../../../src/features/prepare/strings';
import type { App } from '../../../src/shared/contracts';
import { createTestHost, createTestLogger } from '../../helpers/core-host';
import { FakeDramatisApi, installDramatis } from '../../helpers/dramatis';
import type { InstalledDramatis } from '../../helpers/dramatis';
import { installStMock } from '../../helpers/st-mock';
import { analyse, createPrepareEnv, settle, startPrepare } from './helpers';
import type { PrepareEnv, Started } from './helpers';

let dramatis: InstalledDramatis | null = null;

afterEach(() => {
    dramatis?.remove();
    dramatis = null;
});

describe('the Dramatis step of an apply', () => {
    let app: App;
    let step: DramatisStep;
    let api: FakeDramatisApi;

    beforeEach(() => {
        const i18n = createI18n(() => 'ru');
        i18n.register(CORE_STRINGS);
        i18n.register(PREPARE_STRINGS);
        app = { host: createTestHost(installStMock()), i18n, adapters: {} } as unknown as App;
        step = new DramatisStep(app, createTestLogger());
        api = new FakeDramatisApi().upgrade();
    });

    it('is not there without Dramatis or with Dramatis older than 1.3', async () => {
        expect(step.info()).toBeNull();
        expect(await step.run({}, 'apply')).toBeNull();
        expect(step.open()).toBe(false);
        dramatis = installDramatis(app, new FakeDramatisApi());
        expect(step.info()).toBeNull();
        expect(await step.run({ dramatis: true }, 'apply')).toBeNull();
        expect(step.status()).toBeNull();
        // Outside a solo chat Dramatis says null.
        dramatis.remove();
        dramatis = installDramatis(app, api);
        api.intent = null;
        expect(step.info()).toBeNull();
        expect(await step.run({}, 'apply')).toBeNull();
        expect(api.readCalls).toEqual([]);
    });

    it('reads a card Dramatis has not read (the default of a full apply) and says how many it read', async () => {
        dramatis = installDramatis(app, api);
        expect(step.info()).toEqual({ read: false, characters: 0, running: false, canOpen: true });
        const result = await step.run({}, 'apply');
        expect(api.readCalls).toEqual([{}]);
        expect(result).toEqual({
            list: 'done',
            line: { itemId: DRAMATIS_ITEM, kind: 'dramatis', text: 'Dramatis: прочитал личности — 3 персонажа' },
        });
        expect(step.info()).toMatchObject({ read: true, characters: 3 });
        expect(step.status()).toEqual({ characters: 3, line: 'Dramatis: личности из карточки — 3 персонажа' });
        expect(step.open('Вера')).toBe(true);
        expect(api.opened).toEqual(['Вера']);
    });

    it('leaves a card it has read as it is unless asked; asked, it reads it again (force)', async () => {
        dramatis = installDramatis(app, api);
        api.intent = { read: true, characters: 5, groups: 1, running: false };
        expect(await step.run({}, 'apply')).toEqual({
            list: 'done',
            line: {
                itemId: DRAMATIS_ITEM,
                kind: 'dramatis',
                text: 'Dramatis: личности из карточки — 5 персонажей',
                info: true,
            },
        });
        expect(api.readCalls).toEqual([]);
        api.readAnswer = { ok: true, characters: 1 };
        const again = await step.run({ dramatis: true }, 'apply');
        expect(api.readCalls).toEqual([{ force: true }]);
        expect(again?.line.text).toBe('Dramatis: прочитал личности — 1 персонаж');
        expect(again?.line.info).toBeUndefined();
    });

    it('says when Dramatis had nothing new to read, and why a reading failed', async () => {
        dramatis = installDramatis(app, api);
        api.readAnswer = { ok: true, characters: 0, skipped: true };
        api.intent = { read: false, characters: 2, groups: 0, running: false };
        const skipped = await step.run({ dramatis: true }, 'apply');
        expect(skipped?.line).toMatchObject({ text: 'Dramatis: личности из карточки — 2 персонажа', info: true });
        api.readAnswer = { ok: false, characters: 0, error: 'no-profile', message: 'Нет профиля для Dramatis' };
        expect(await step.run({ dramatis: true }, 'apply')).toEqual({
            list: 'failed',
            line: {
                itemId: DRAMATIS_ITEM,
                kind: 'dramatis',
                text: 'Dramatis: личности не прочитаны — Нет профиля для Dramatis',
            },
        });
        api.readIntent = async () => {
            throw new Error('model down');
        };
        expect((await step.run({ dramatis: true }, 'apply'))?.line.text).toBe(
            'Dramatis: личности не прочитаны — model down',
        );
    });

    it('never reads for the saved preparation unless asked; not read yet is a skipped line', async () => {
        dramatis = installDramatis(app, api);
        expect(await step.run({}, 'import')).toEqual({
            list: 'skipped',
            line: { itemId: DRAMATIS_ITEM, kind: 'dramatis', text: 'Dramatis: личности из карточки ещё не прочитаны' },
        });
        expect(await step.run({ dramatis: false }, 'apply')).toMatchObject({ list: 'skipped' });
        expect(api.readCalls).toEqual([]);
        expect(step.status()).toBeNull();
    });
});

describe('applying the preparation with Dramatis 1.3', () => {
    let env: PrepareEnv;
    let started: Started;

    beforeEach(() => {
        env = createPrepareEnv();
        started = startPrepare(env);
    });

    afterEach(() => {
        started.stop();
    });

    it('reads the card as part of applying; the line is in «Итог», with no undo of its own', async () => {
        dramatis = installDramatis(env.app, new FakeDramatisApi().upgrade());
        const api = started.service.api();
        expect(api.dramatisIntent()).toEqual({ read: false, characters: 0, running: false, canOpen: true });
        await analyse(started.service);
        const summary = await started.service.apply('all', { passports: false });
        await settle(10);
        expect(dramatis.api.readCalls).toEqual([{}]);
        const line = summary.done.find((row) => row.kind === 'dramatis');
        expect(line).toEqual({
            itemId: 'dramatis',
            kind: 'dramatis',
            text: 'Dramatis: прочитал личности — 3 персонажа',
        });
        // Counted as a part of the apply (the user asked for it), but not kept for undo: Dramatis journals it.
        const parts = summary.done.length;
        expect(env.ui.notices.at(-1)?.text).toBe(`Подготовка применена, частей: ${parts}`);
        const doc = await env.app.chat.get<{ applied: { itemId: string }[] }>('prepare', () => ({ applied: [] }));
        expect(doc.applied.some((row) => row.itemId === 'dramatis')).toBe(false);
        expect(api.dramatisIntent()).toMatchObject({ read: true, characters: 3 });
        expect((await api.status()).dramatis).toEqual({
            characters: 3,
            line: 'Dramatis: личности из карточки — 3 персонажа',
        });
        expect(api.openDramatis()).toBe(true);
        expect(dramatis.api.opened).toEqual([undefined]);
    });

    it('a card Dramatis has read: an information line that is not a written part', async () => {
        dramatis = installDramatis(env.app, new FakeDramatisApi().upgrade());
        dramatis.api.intent = { read: true, characters: 4, groups: 0, running: false };
        await analyse(started.service);
        const summary = await started.service.apply('all', { passports: false });
        await settle(10);
        expect(dramatis.api.readCalls).toEqual([]);
        const info = summary.done.find((row) => row.kind === 'dramatis');
        expect(info).toMatchObject({ text: 'Dramatis: личности из карточки — 4 персонажа', info: true });
        expect(env.ui.notices.at(-1)?.text).toBe(`Подготовка применена, частей: ${summary.done.length - 1}`);
    });

    it('changes nothing with Dramatis 1.2', async () => {
        dramatis = installDramatis(env.app, new FakeDramatisApi());
        expect(started.service.api().dramatisIntent()).toBeNull();
        await analyse(started.service);
        const summary = await started.service.apply('all', { passports: false, dramatis: true });
        expect([...summary.done, ...summary.failed, ...summary.skipped].some((row) => row.kind === 'dramatis')).toBe(
            false,
        );
        expect((await started.service.status()).dramatis).toBeUndefined();
    });
});
