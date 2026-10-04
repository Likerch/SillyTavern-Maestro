// «История версий» (plan M23 new possibility 4): previous versions of the entry saved through the store (newest
// first), who changed it, «было / стало» against the current entry and «Вернуть эту версию» (saved as a normal
// change, so the current state lands in the history too and the restore can be undone the same way).
import { restorePatch } from '../../../domain/lore-form-fields';
import { banner, emptyState } from '../../../ui/components/card';
import { button, el } from '../../../ui/components/dom';
import { diffView } from '../../../ui/components/diff';
import { formatTime, moduleTitle } from '../../../ui/views/format';
import type { EntryVersion } from '../store-api';
import { formSection } from './controls';
import type { FormEnv } from './env';

/** Versions listed before «Показать все». */
export const HISTORY_SHOWN = 10;

const AUTHORS = new Set(['user', 'localizer', 'ck', 'st']);

function authorText(env: FormEnv, by: string): string {
    if (AUTHORS.has(by)) return env.t(`m23f.hist.by.${by}`);
    return moduleTitle(env.app.modules, env.app.i18n, by);
}

async function restore(env: FormEnv, version: EntryVersion): Promise<void> {
    const t = env.t;
    const patch = restorePatch(env.state.stored, version.entry);
    if (!Object.keys(patch).length) {
        env.status(t('m23f.hist.same'), 'info');
        return;
    }
    if (env.isDirty() && !(await env.app.ui.confirm(t('m23f.discard.title'), t('m23f.hist.discardBody')))) return;
    const time = formatTime(version.at, env.app.i18n);
    await env.ctx.store.updateEntry(env.ctx.book, env.ctx.uid, patch, {
        module: 'M23',
        summary: t('m23f.hist.restoreSummary', { time, entry: String(env.ctx.uid) }),
    });
    await env.reload();
    env.ctx.onSaved();
    env.status(t('m23f.hist.restored', { time }), 'ok');
}

function versionRow(env: FormEnv, version: EntryVersion): HTMLElement {
    const t = env.t;
    const diff = el('div', { class: 'maestro-m23f-hist-diff' });
    diff.hidden = true;
    const toggle = button({
        label: t('m23f.hist.diff'),
        kind: 'ghost',
        icon: 'fa-code-compare',
        onClick: () => {
            if (diff.hidden && !diff.firstChild) diff.append(diffView(version.entry, env.state.stored, t));
            diff.hidden = !diff.hidden;
            toggle.setAttribute('aria-expanded', diff.hidden ? 'false' : 'true');
        },
    });
    toggle.setAttribute('aria-expanded', 'false');
    return el('li', { class: 'maestro-m23f-hist-item' }, [
        el('div', { class: 'maestro-m23f-hist-head' }, [
            el('span', { class: 'maestro-m23f-hist-time', text: formatTime(version.at, env.app.i18n) }),
            el('span', { class: 'maestro-m23f-hist-by', text: authorText(env, version.by) }),
            version.summary ? el('span', { class: 'maestro-m23f-hist-summary', text: version.summary }) : null,
        ]),
        el('div', { class: 'maestro-m23f-actions' }, [
            toggle,
            env.readOnly
                ? null
                : button({
                      label: t('m23f.hist.restore'),
                      icon: 'fa-clock-rotate-left',
                      onClick: () => restore(env, version),
                  }),
        ]),
        diff,
    ]);
}

export function historySection(env: FormEnv): HTMLElement {
    const t = env.t;
    const body = el('div', { class: 'maestro-m23f-hist' }, [
        el('div', { class: 'maestro-m23f-hint', text: t('m23f.loading') }),
    ]);
    let alive = true;
    env.own(() => {
        alive = false;
    });
    void env.ctx.store
        .history(env.ctx.book, env.ctx.uid)
        .then((versions) => {
            if (!alive) return;
            if (!versions.length) {
                body.replaceChildren(emptyState(t('m23f.hist.empty'), 'fa-clock-rotate-left'));
                return;
            }
            const list = el('ul', { class: 'maestro-m23f-list maestro-m23f-hist-list' });
            const show = (count: number) =>
                list.replaceChildren(...versions.slice(0, count).map((v) => versionRow(env, v)));
            show(HISTORY_SHOWN);
            const more: HTMLButtonElement | null =
                versions.length > HISTORY_SHOWN
                    ? button({
                          label: t('m23f.hist.all', { count: versions.length }),
                          kind: 'ghost',
                          onClick: () => {
                              show(versions.length);
                              more?.remove();
                          },
                      })
                    : null;
            body.replaceChildren(list, ...(more ? [more] : []));
        })
        .catch((error: unknown) => {
            env.app.log.debug('history failed', error);
            if (alive) body.replaceChildren(banner(t('m23f.hist.failed'), 'error'));
        });
    return formSection(t('m23f.section.history'), [body], { id: 'history', open: false });
}
