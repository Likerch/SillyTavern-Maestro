// Canon of the chat next to the base (plan M23 new possibility 9, M6): for an entry of a base book — its override
// in the chat canon side by side with a diff, and «Переопределить в каноне» / «Подавить в этом чате» /
// «Закрепить» / «Повысить до базы» / «Убрать переопределение». For an entry of the canon book — its CanonMeta
// (kind, status, origin, link to the base, provisional badge). The base book is never written here (P2); promotion
// goes through canon.promote (level «ask»).
import { contentHash } from '../../../domain/lore-form-fields';
import { stringList } from '../../../domain/lore-form-keys';
import { badge, banner } from '../../../ui/components/card';
import { button, el } from '../../../ui/components/dom';
import { diffView } from '../../../ui/components/diff';
import { formatTime } from '../../../ui/views/format';
import type { CanonApi, CanonItem, CanonKind, CanonMeta } from '../../canon/api';
import { formSection } from './controls';
import { canonApi } from './env';
import type { FormEnv } from './env';

interface BaseItems {
    override?: CanonItem;
    suppress?: CanonItem;
    pin?: CanonItem;
}

function isCanonMeta(value: unknown): value is CanonMeta {
    if (typeof value !== 'object' || value === null) return false;
    const meta = value as Record<string, unknown>;
    return typeof meta.kind === 'string' && typeof meta.status === 'string';
}

/** CanonMeta of a canon entry (kept in `extensions.maestro`). */
export function canonMetaOf(entry: Record<string, unknown>): CanonMeta | null {
    const extensions = entry.extensions;
    if (typeof extensions !== 'object' || extensions === null) return null;
    const meta = (extensions as Record<string, unknown>).maestro;
    return isCanonMeta(meta) ? meta : null;
}

async function itemsFor(canon: CanonApi, book: string, uid: number): Promise<BaseItems> {
    const list = await canon.list();
    const result: BaseItems = {};
    for (const item of list) {
        const base = item.meta.base;
        if (!base || base.world !== book || base.uid !== uid) continue;
        if (item.meta.status === 'archived') continue;
        if (item.meta.kind === 'override' || item.meta.kind === 'suppress' || item.meta.kind === 'pin') {
            result[item.meta.kind] ??= item;
        }
    }
    return result;
}

function statusBadge(env: FormEnv, meta: CanonMeta): HTMLElement {
    const level = meta.status === 'provisional' ? 'warn' : meta.status === 'archived' ? 'muted' : 'ok';
    const text =
        meta.status === 'provisional' && typeof meta.survivedTurns === 'number'
            ? env.t('m23f.canon.provisionalTurns', { count: meta.survivedTurns })
            : env.t(`m23f.canon.status.${meta.status}`);
    return badge(text, level);
}

function side(title: string, content: string, keys: string[], env: FormEnv): HTMLElement {
    return el('div', { class: 'maestro-m23f-side' }, [
        el('div', { class: 'maestro-m23f-side-title', text: title }),
        el('div', {
            class: 'maestro-m23f-side-keys',
            text: keys.length ? keys.join(', ') : env.t('m23f.canon.noKeys'),
        }),
        el('pre', { class: 'maestro-m23f-side-text', text: content || env.t('m23f.canon.emptyContent') }),
    ]);
}

async function act(env: FormEnv, run: () => Promise<unknown>, done: string): Promise<void> {
    try {
        await run();
        env.status(done, 'ok');
    } catch (error) {
        env.status(
            env.t('m23f.canon.failed', { error: error instanceof Error ? error.message : String(error) }),
            'error',
        );
    }
}

function baseActions(env: FormEnv, canon: CanonApi, items: BaseItems, refresh: () => Promise<void>): HTMLElement {
    const t = env.t;
    const { book, uid } = env.ctx;
    const stored = env.state.stored;
    const baseContent = typeof stored.content === 'string' ? stored.content : '';
    // `content` is the base text «then» for baseDrift(); the hash equals roles-meta entryContentHash (stableHash).
    const baseRef = { world: book, uid, contentHash: contentHash(baseContent), content: baseContent };
    const put = (kind: CanonKind, entry: Record<string, unknown> = {}, extra: Partial<CanonMeta> = {}) =>
        canon.put({ entry, meta: { kind, status: 'active', origin: 'user', base: baseRef, ...extra } });

    const buttons: HTMLElement[] = [];
    if (!items.override) {
        buttons.push(
            button({
                label: t('m23f.canon.override'),
                icon: 'fa-code-branch',
                kind: 'primary',
                title: t('m23f.canon.overrideHint'),
                onClick: async () => {
                    if (env.isDirty()) {
                        env.status(t('m23f.canon.saveFirst'), 'warn');
                        return;
                    }
                    // The override starts as a copy of the stored base entry (every field but the uid).
                    const copy: Record<string, unknown> = { ...stored };
                    delete copy.uid;
                    const type = env.state.typed?.type;
                    try {
                        const book = await canon.ensureBook();
                        const created = await put('override', copy, type ? { type } : {});
                        env.status(t('m23f.canon.overrideDone'), 'ok');
                        env.navigate(book || canon.bookName(), created);
                    } catch (error) {
                        env.status(
                            t('m23f.canon.failed', { error: error instanceof Error ? error.message : String(error) }),
                            'error',
                        );
                    }
                },
            }),
        );
    } else {
        const override = items.override;
        buttons.push(
            button({
                label: t('m23f.canon.editOverride'),
                icon: 'fa-pen',
                kind: 'primary',
                onClick: () => env.navigate(canon.bookName(), override.uid),
            }),
            button({
                label: t('m23f.canon.promote'),
                icon: 'fa-arrow-up-from-bracket',
                title: t('m23f.canon.promoteHint'),
                onClick: async () => {
                    const applied = await canon.promote(override.uid).catch((error: unknown) => {
                        env.status(t('m23f.canon.failed', { error: String(error) }), 'error');
                        return null;
                    });
                    if (applied === true) {
                        env.status(t('m23f.canon.promoted'), 'ok');
                        await env.reload();
                    } else if (applied === false) env.status(t('m23f.canon.promoteDeclined'), 'info');
                },
            }),
            button({
                label: t('m23f.canon.removeOverride'),
                icon: 'fa-trash-can',
                kind: 'danger',
                onClick: async () => {
                    if (!(await env.app.ui.confirm(t('m23f.canon.removeTitle'), t('m23f.canon.removeBody')))) return;
                    await act(env, () => canon.remove(override.uid), t('m23f.canon.removed'));
                    await refresh();
                },
            }),
        );
    }
    const suppress = items.suppress;
    buttons.push(
        suppress
            ? button({
                  label: t('m23f.canon.unsuppress'),
                  icon: 'fa-eye',
                  onClick: async () => {
                      await act(env, () => canon.remove(suppress.uid), t('m23f.canon.unsuppressed'));
                      await refresh();
                  },
              })
            : button({
                  label: t('m23f.canon.suppress'),
                  icon: 'fa-eye-slash',
                  title: t('m23f.canon.suppressHint'),
                  onClick: async () => {
                      await act(env, () => put('suppress'), t('m23f.canon.suppressed'));
                      await refresh();
                  },
              }),
    );
    const pin = items.pin;
    buttons.push(
        pin
            ? button({
                  label: t('m23f.canon.unpin'),
                  icon: 'fa-thumbtack',
                  onClick: async () => {
                      await act(env, () => canon.remove(pin.uid), t('m23f.canon.unpinned'));
                      await refresh();
                  },
              })
            : button({
                  label: t('m23f.canon.pin'),
                  icon: 'fa-thumbtack',
                  title: t('m23f.canon.pinHint'),
                  onClick: async () => {
                      await act(env, () => put('pin', {}, { pinWhen: 'always' }), t('m23f.canon.pinned'));
                      await refresh();
                  },
              }),
    );
    return el('div', { class: 'maestro-m23f-actions' }, buttons);
}

function baseView(env: FormEnv, canon: CanonApi, items: BaseItems, refresh: () => Promise<void>): HTMLElement[] {
    const t = env.t;
    const stored = env.state.stored;
    const baseContent = typeof stored.content === 'string' ? stored.content : '';
    const baseKeys = stringList(stored.key);
    const nodes: HTMLElement[] = [];
    if (items.suppress) nodes.push(banner(t('m23f.canon.isSuppressed'), 'warn', 'fa-eye-slash'));
    if (items.pin) nodes.push(banner(t('m23f.canon.isPinned'), 'info', 'fa-thumbtack'));
    const override = items.override;
    if (override) {
        const content = typeof override.entry.content === 'string' ? override.entry.content : '';
        const keys = stringList(override.entry.key);
        if (override.meta.base && override.meta.base.contentHash !== contentHash(baseContent)) {
            nodes.push(banner(t('m23f.canon.drift'), 'warn', 'fa-code-compare'));
        }
        nodes.push(
            el('div', { class: 'maestro-m23f-row-inline' }, [statusBadge(env, override.meta)]),
            el('div', { class: 'maestro-m23f-sides' }, [
                side(t('m23f.canon.base'), baseContent, baseKeys, env),
                side(t('m23f.canon.override.title'), content, keys, env),
            ]),
            el('div', { class: 'maestro-m23f-label', text: t('m23f.canon.diff') }),
            diffView(baseContent, content, t),
        );
        if (baseKeys.join('\u0000') !== keys.join('\u0000')) {
            nodes.push(
                el('div', { class: 'maestro-m23f-label', text: t('m23f.canon.keysDiff') }),
                diffView(baseKeys, keys, t),
            );
        }
    } else {
        nodes.push(el('div', { class: 'maestro-m23f-hint', text: t('m23f.canon.noOverride') }));
    }
    nodes.push(baseActions(env, canon, items, refresh));
    return nodes;
}

function canonEntryView(env: FormEnv, canon: CanonApi | undefined, meta: CanonMeta): HTMLElement[] {
    const t = env.t;
    const nodes: HTMLElement[] = [
        el('div', { class: 'maestro-m23f-row-inline' }, [
            badge(t(`m23f.canon.kind.${meta.kind}`), 'info'),
            statusBadge(env, meta),
            badge(t(`m23f.canon.origin.${meta.origin}`), 'muted'),
        ]),
    ];
    if (meta.status === 'provisional') nodes.push(banner(t('m23f.canon.provisionalNote'), 'warn', 'fa-hourglass-half'));
    const base = meta.base;
    if (base) {
        nodes.push(
            el('div', { class: 'maestro-m23f-row-inline' }, [
                el('span', { text: t('m23f.canon.baseLink', { book: base.world, uid: base.uid }) }),
                button({
                    label: t('m23f.canon.openBase'),
                    icon: 'fa-book-atlas',
                    kind: 'ghost',
                    onClick: () => env.navigate(base.world, base.uid),
                }),
            ]),
        );
        const drift = el('div');
        nodes.push(drift);
        void env.ctx.store
            .load(base.world)
            .then((data) => {
                const entry = data?.entries[String(base.uid)];
                if (!entry) {
                    drift.replaceChildren(banner(t('m23f.canon.baseGone'), 'warn'));
                    return;
                }
                const now = typeof entry.content === 'string' ? entry.content : '';
                if (contentHash(now) !== base.contentHash) {
                    drift.replaceChildren(
                        banner(t('m23f.canon.drift'), 'warn', 'fa-code-compare'),
                        el('div', { class: 'maestro-m23f-label', text: t('m23f.canon.diffBaseNow') }),
                        diffView(now, String(env.state.stored.content ?? ''), t),
                    );
                }
            })
            .catch((error: unknown) => env.app.log.debug('base load failed', error));
    }
    const times = [
        meta.createdAt ? t('m23f.canon.created', { time: formatTime(meta.createdAt, env.app.i18n) }) : null,
        meta.updatedAt ? t('m23f.canon.updated', { time: formatTime(meta.updatedAt, env.app.i18n) }) : null,
        typeof meta.sourceMessage === 'number' ? t('m23f.canon.source', { index: meta.sourceMessage }) : null,
    ].filter((item): item is string => !!item);
    if (times.length) nodes.push(el('div', { class: 'maestro-m23f-hint', text: times.join(' · ') }));
    if (canon && meta.kind === 'override' && !env.readOnly) {
        nodes.push(
            el('div', { class: 'maestro-m23f-actions' }, [
                button({
                    label: t('m23f.canon.promote'),
                    icon: 'fa-arrow-up-from-bracket',
                    title: t('m23f.canon.promoteHint'),
                    onClick: async () => {
                        const applied = await canon.promote(env.ctx.uid);
                        env.status(
                            t(applied ? 'm23f.canon.promoted' : 'm23f.canon.promoteDeclined'),
                            applied ? 'ok' : 'info',
                        );
                    },
                }),
            ]),
        );
    }
    return nodes;
}

/** The canon block, or null when it does not apply (no canon module / chat, read-only book). */
export function canonSection(env: FormEnv): HTMLElement | null {
    const t = env.t;
    const canon = canonApi(env.app);
    if (env.state.isCanonEntry) {
        const meta = canonMetaOf(env.state.stored);
        if (!meta) return null;
        return formSection(t('m23f.section.canonEntry'), canonEntryView(env, canon, meta), { id: 'canon' });
    }
    if (!canon || env.readOnly || !env.state.canonBook) return null;
    const body = el('div', { class: 'maestro-m23f-canon' }, [
        el('div', { class: 'maestro-m23f-hint', text: t('m23f.loading') }),
    ]);
    let alive = true;
    env.own(() => {
        alive = false;
    });
    const refresh = async () => {
        try {
            const items = await itemsFor(canon, env.ctx.book, env.ctx.uid);
            if (alive) body.replaceChildren(...baseView(env, canon, items, refresh));
        } catch (error) {
            if (alive) body.replaceChildren(banner(t('m23f.canon.loadFailed'), 'error'));
            env.app.log.debug('canon list failed', error);
        }
    };
    void refresh();
    try {
        env.own(canon.onChange(() => void refresh()));
    } catch (error) {
        env.app.log.debug('canon onChange failed', error);
    }
    return formSection(t('m23f.section.canon', { book: env.state.canonBook }), [body], { id: 'canon' });
}
