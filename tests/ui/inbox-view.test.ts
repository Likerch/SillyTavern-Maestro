// @vitest-environment happy-dom
// The Inbox view of M8: cards grouped by entity, evidence and confidence, inline edit (accepted as 'edited'),
// «Всегда так», and the revision's deferred cards. The base behaviour (accept/reject/snooze, mass accept, stale
// cards) is covered in views.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLabels } from '../../src/core/labels';
import { revisionModule } from '../../src/features/revision';
import { REVISION_STRINGS } from '../../src/features/revision/strings';
import type { InboxCard } from '../../src/shared/contracts';
import { createUi } from '../../src/ui';
import type { UiImpl } from '../../src/ui';
import { cardMeta, groupByEntity } from '../../src/ui/views/inbox';
import { resetRegistries } from '../../src/ui/views/registries';
import { buildStDom, frontBody, installUiEnv } from '../helpers/ui-env';
import type { UiTestEnv } from '../helpers/ui-env';
import { coreFakes, fakeAutonomy, FakeInbox, FakeModules, inboxCard } from '../helpers/ui-fakes';
import type { CoreFakes } from '../helpers/ui-fakes';

/** Records the edited payload accept() receives. */
class EditingInbox extends FakeInbox {
    readonly edits: { id: string; edited: unknown }[] = [];
    override async accept(id: string, edited?: unknown): Promise<boolean> {
        if (edited !== undefined) this.edits.push({ id, edited });
        return super.accept(id);
    }
}

interface DeferredFake {
    id: string;
    target: string;
    entityName: string;
    value: string;
    evidence: string;
    sourceMessage: number;
    at: number;
}

class RevisionModules extends FakeModules {
    revision: unknown;
    override api<T>(key?: string): T | undefined {
        return (key === 'revision' ? this.revision : undefined) as T | undefined;
    }
}

let env: UiTestEnv;
let ui: UiImpl | undefined;
let fakes: CoreFakes & { inbox: EditingInbox };

const body = () => frontBody()!;
const buttonByText = (text: string, root: ParentNode = document) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === text);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const cardWith = (title: string) =>
    [...body().querySelectorAll<HTMLElement>('.maestro-inbox-card')].find((node) => node.textContent?.includes(title))!;

function revisionCard(id: string, entityName: string, overrides: Partial<InboxCard> = {}): InboxCard {
    return inboxCard(id, {
        kind: 'canon.fact',
        title: `${entityName}: card ${id}`,
        payload: {
            m8: 1,
            entityName,
            value: `${entityName} now lives in Paris.`,
            editable: true,
            evidence: 'Я теперь живу в Париже.',
            confidence: 0.87,
        },
        ...overrides,
    });
}

function start(locale: 'ru' | 'en', overrides: Partial<CoreFakes> = {}): void {
    env = installUiEnv(locale);
    env.settings.core().firstRunDone = true;
    const shell = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui = shell;
    shell.mount();
    fakes = coreFakes(env, { inbox: new EditingInbox(), ...overrides }) as CoreFakes & { inbox: EditingInbox };
    shell.registerCoreViews(fakes);
}

beforeEach(() => {
    resetRegistries();
    buildStDom(5);
});

afterEach(() => {
    ui?.dispose();
    ui = undefined;
});

describe('payload convention', () => {
    it('reads entity, value, evidence and confidence when present', () => {
        expect(cardMeta(revisionCard('1', 'Anna'))).toEqual({
            entityName: 'Anna',
            value: 'Anna now lives in Paris.',
            editable: true,
            evidence: 'Я теперь живу в Париже.',
            confidence: 0.87,
        });
        expect(cardMeta(inboxCard('2', { payload: 'x' }))).toEqual({ entityName: '', editable: false });
        expect(cardMeta(inboxCard('3', { payload: { value: 'v', confidence: 4, evidence: ' ' } }))).toEqual({
            entityName: '',
            value: 'v',
            editable: false,
            confidence: 1,
        });
    });

    it('groups by entity, the newest group first, cards without an entity last', () => {
        const groups = groupByEntity([
            revisionCard('1', 'Anna', { createdAt: 10 }),
            inboxCard('2', { createdAt: 50 }),
            revisionCard('3', 'Boris', { createdAt: 30 }),
            revisionCard('4', 'Anna', { createdAt: 20 }),
        ]);
        expect(groups.map((group) => [group.entity, group.cards.map((item) => item.id)])).toEqual([
            ['Boris', ['3']],
            ['Anna', ['1', '4']],
            ['', ['2']],
        ]);
    });
});

describe('Inbox view (M8)', () => {
    it('groups cards by entity and shows evidence and confidence', () => {
        start('ru');
        env.i18n.register(REVISION_STRINGS);
        fakes.inbox.set([revisionCard('1', 'Anna'), revisionCard('2', 'Boris'), inboxCard('3', { title: 'Plain' })]);
        ui!.openPult('inbox');
        const heads = [...body().querySelectorAll('.maestro-inbox-group-head')].map((node) => node.textContent);
        expect(heads).toEqual(['Anna1', 'Boris1', 'Прочее1']);
        const anna = cardWith('Anna: card 1');
        expect(anna.querySelector('.maestro-inbox-evidence')?.textContent).toBe('Я теперь живу в Париже.');
        // The store head stays the raw target unless the module names it.
        expect(anna.querySelector('.maestro-change-target')?.textContent).toBe('lorebook-entry');
        expect(anna.textContent).toContain('уверенность 87%');
        expect(cardWith('Plain').querySelector('.maestro-inbox-evidence')).toBeNull();
        expect(buttonByText('Изменить', cardWith('Plain'))).toBeUndefined();
    });

    it("keeps the revision's English values and store addresses under «Подробнее»; a nickname reads in words", () => {
        const labels = createLabels();
        labels.register(revisionModule.targets ?? []);
        start('ru', { labels });
        env.i18n.register(REVISION_STRINGS);
        fakes.inbox.set([
            revisionCard('1', 'Anna', {
                changes: [
                    { target: 'revision.canon', ref: { world: 'World', uid: 1 }, before: 'Rome', after: 'Paris' },
                    { target: 'revision.passport', ref: { id: 'p1', slot: 'hair' }, before: 'long', after: 'short' },
                    {
                        target: 'revision.alias',
                        ref: { alias: 'Аня' },
                        before: null,
                        after: { alias: 'Аня', entity: 'Anna' },
                    },
                ],
            }),
        ]);
        ui!.openPult('inbox');
        const card = cardWith('Anna: card 1');
        const details = card.querySelector<HTMLDetailsElement>('details.maestro-details')!;
        expect(details.open).toBe(false);
        const main = [...card.querySelectorAll('.maestro-change-human')].map((node) => node.textContent);
        expect(main).toEqual(['ПрозвищеПрозвищеАняКтоAnna']);
        expect(details.textContent).toContain('revision.canon');
        expect(details.textContent).toContain('world: World, uid: 1');
        expect(details.textContent).toContain('Вид действия: canon.fact');
        const outside = card.textContent!.replace(details.textContent!, '');
        expect(outside).not.toContain('revision.');
        expect(outside).not.toContain('uid');
        expect(outside).not.toContain('canon.fact');
    });

    it('keeps the plain list when no card names an entity', () => {
        start('ru');
        fakes.inbox.set([inboxCard('1'), inboxCard('2')]);
        ui!.openPult('inbox');
        expect(body().querySelector('.maestro-inbox-group')).toBeNull();
        expect(body().querySelectorAll('.maestro-inbox-card')).toHaveLength(2);
    });

    it('edits the value inline and accepts it as edited; cancel drops the draft', async () => {
        start('ru');
        env.i18n.register(REVISION_STRINGS);
        fakes.inbox.set([revisionCard('1', 'Anna'), revisionCard('2', 'Boris')]);
        ui!.openPult('inbox');
        buttonByText('Изменить', cardWith('Anna: card 1'))!.click();
        let area = cardWith('Anna: card 1').querySelector('textarea')!;
        expect(area.value).toBe('Anna now lives in Paris.');
        expect(buttonByText('Изменить', cardWith('Anna: card 1'))).toBeUndefined();
        area.value = 'Anna lives in Lyon.';
        area.dispatchEvent(new Event('input'));
        // A re-render (another card changed) keeps the draft.
        fakes.inbox.changed();
        await new Promise((resolve) => setTimeout(resolve, 80));
        area = cardWith('Anna: card 1').querySelector('textarea')!;
        expect(area.value).toBe('Anna lives in Lyon.');
        buttonByText('Сохранить и принять', cardWith('Anna: card 1'))!.click();
        await flush();
        expect(fakes.inbox.edits).toEqual([
            { id: '1', edited: expect.objectContaining({ entityName: 'Anna', value: 'Anna lives in Lyon.', m8: 1 }) },
        ]);
        await new Promise((resolve) => setTimeout(resolve, 80));
        buttonByText('Изменить', cardWith('Boris: card 2'))!.click();
        expect(cardWith('Boris: card 2').querySelector('textarea')).not.toBeNull();
        buttonByText('Отмена', cardWith('Boris: card 2'))!.click();
        expect(cardWith('Boris: card 2').querySelector('textarea')).toBeNull();
    });

    it('reports an edited card that could not be applied', async () => {
        start('ru');
        env.i18n.register(REVISION_STRINGS);
        fakes.inbox.set([revisionCard('1', 'Anna')]);
        fakes.inbox.stale.add('1');
        ui!.openPult('inbox');
        buttonByText('Изменить')!.click();
        buttonByText('Сохранить и принять')!.click();
        await flush();
        ui!.openPult('overview');
        expect(body().textContent).toContain('«Anna: card 1» не применено: проверь значение');
    });

    it('«Всегда так» raises the kind to auto and accepts the card; hidden when the kind may never be auto', async () => {
        const autonomy = {
            ...fakeAutonomy(),
            level: (kind: string, fallback: 'auto' | 'inbox') => (kind === 'chat.alias' ? 'auto' : fallback),
            isNeverAuto: (kind: string) => kind === 'des.alias',
        };
        start('ru', { autonomy });
        env.i18n.register(REVISION_STRINGS);
        const notify = vi.spyOn(env.settings, 'notify');
        fakes.inbox.set([
            revisionCard('1', 'Anna'),
            revisionCard('2', 'Anna', { kind: 'des.alias', title: 'Anna: note' }),
            revisionCard('3', 'Anna', { kind: 'chat.alias', title: 'Anna: alias' }),
            revisionCard('4', 'Anna', { deferred: true, title: 'Anna: waiting' }),
        ]);
        ui!.openPult('inbox');
        expect(buttonByText('Всегда так', cardWith('Anna: note'))).toBeUndefined();
        expect(buttonByText('Всегда так', cardWith('Anna: alias'))).toBeUndefined();
        expect(buttonByText('Всегда так', cardWith('Anna: waiting'))).toBeUndefined();
        expect(buttonByText('Изменить', cardWith('Anna: waiting'))).toBeUndefined();
        const always = buttonByText('Всегда так', cardWith('Anna: card 1'))!;
        expect(always.title).toBe('Принять, и дальше такие изменения я делаю сам');
        always.click();
        await flush();
        expect(env.settings.core().autonomy).toEqual({ 'canon.fact': 'auto' });
        expect(notify).toHaveBeenCalledWith('core.autonomy.canon.fact');
        expect(fakes.inbox.accepted).toEqual(['1']);
        ui!.openPult('overview');
        expect(body().textContent).toContain('Хорошо: «Перемены в известном о персонажах и местах» дальше делаю сам.');
    });

    it('snooze keeps its label and explains itself', () => {
        start('ru');
        env.i18n.register(REVISION_STRINGS);
        fakes.inbox.set([revisionCard('1', 'Anna')]);
        ui!.openPult('inbox');
        expect(buttonByText('Завтра')?.title).toBe('Отложить до завтра');
    });

    it('shows the deferred cards of the revision with their stage, source and «Убрать»', async () => {
        const modules = new RevisionModules();
        let deferred: DeferredFake[] = [
            {
                id: 'd1',
                target: 'deferred.outfit',
                entityName: 'Anna',
                value: 'A red evening dress.',
                evidence: 'Красное платье.',
                sourceMessage: 3,
                at: 1_700_000_000_000,
            },
            {
                id: 'd2',
                target: 'deferred.promise',
                entityName: 'Boris',
                value: 'Boris promised to return by dawn.',
                evidence: '',
                sourceMessage: 2,
                at: 1_700_000_000_000,
            },
        ];
        const listeners = new Set<() => void>();
        const dismiss = vi.fn(async (id: string) => {
            deferred = deferred.filter((card) => card.id !== id);
            for (const listener of listeners) listener();
        });
        modules.revision = {
            deferred: () => deferred,
            dismissDeferred: dismiss,
            onChange: (listener: () => void) => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
        };
        start('ru', { modules });
        env.i18n.register(REVISION_STRINGS);
        ui!.openPult('inbox');
        expect(body().querySelector('.maestro-empty')?.textContent).toBe('Во «Входящих» пусто.');
        const cards = [...body().querySelectorAll<HTMLElement>('.maestro-inbox-deferred')];
        expect(cards.map((node) => node.querySelector('.maestro-card-title')?.textContent)).toEqual([
            'Anna: наряд',
            'Boris: обещание',
        ]);
        expect(cards[0]!.textContent).toContain('Отложено до этапа 10');
        expect(cards[1]!.textContent).toContain('Отложено до этапа 9');
        expect(cards[0]!.querySelector('.maestro-inbox-evidence')?.textContent).toBe('Красное платье.');
        buttonByText('Убрать', cards[1])!.click();
        await flush();
        expect(dismiss).toHaveBeenCalledWith('d2');
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(body().querySelectorAll('.maestro-inbox-deferred')).toHaveLength(1);
        buttonByText('Сообщение №3', body())!.click();
        expect(document.querySelector('#chat .mes[mesid="3"]')?.classList.contains('maestro-flash')).toBe(true);
    });

    it('works with English fallbacks when the revision strings are not registered', () => {
        const modules = new RevisionModules();
        modules.revision = {
            deferred: () => [
                {
                    id: 'd1',
                    target: 'deferred.secret',
                    entityName: 'Anna',
                    value: 'v',
                    evidence: '',
                    sourceMessage: 1,
                    at: 0,
                },
            ],
        };
        // A core-like autonomy without isNeverAuto: level() refuses 'auto' for never-auto kinds.
        const never = new Set(['des.alias']);
        const autonomy = {
            ...fakeAutonomy(),
            level: (kind: string, fallback: 'inbox') => {
                const stored = env.settings.core().autonomy[kind] ?? fallback;
                return stored === 'auto' && never.has(kind) ? fallback : stored;
            },
        };
        start('en', { modules, autonomy });
        fakes.inbox.set([
            revisionCard('1', 'Anna'),
            revisionCard('2', 'Anna', { kind: 'des.alias', title: 'Anna: note' }),
        ]);
        ui!.openPult('inbox');
        expect(buttonByText('Edit')).toBeDefined();
        expect(buttonByText('Always', cardWith('Anna: card 1'))).toBeDefined();
        expect(buttonByText('Always', cardWith('Anna: note'))).toBeUndefined();
        expect(env.settings.core().autonomy).toEqual({});
        expect(body().textContent).toContain('confidence 87%');
        expect(body().textContent).toContain('Deferred until stage 9');
        expect(body().textContent).toContain('Anna: deferred.secret');
        expect(buttonByText('Remove')).toBeUndefined();
    });

    it('survives a revision API that throws', () => {
        const modules = new RevisionModules();
        modules.revision = {
            deferred: () => {
                throw new Error('broken');
            },
            onChange: () => {
                throw new Error('broken');
            },
        };
        start('ru', { modules });
        ui!.openPult('inbox');
        expect(body().querySelector('.maestro-empty')).not.toBeNull();
    });
});
