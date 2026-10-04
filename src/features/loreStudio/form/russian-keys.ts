// «Русские ключи» (plan M23 new possibility 7): the Lorebook Localizer localizes this entry without its dialog when
// its API is there (it writes the book itself and marks the keys it added); otherwise the canon module's Russian
// forms (DES-RU declensions) of every English key are appended to the draft as a new array. Never for BunnyMo
// books (P13: no Russian keys in packs) or books whose role is not localizable.
import { englishTerms, mergeKeys, stringList } from '../../../domain/lore-form-keys';
import { button, el } from '../../../ui/components/dom';
import { canonApi, localizerApi } from './env';
import type { FormEnv } from './env';

function localizable(env: FormEnv): boolean {
    const role = env.role;
    if (!role) return true;
    if (role.role === 'bunnymo.core' || role.role === 'bunnymo.pack') return false;
    return role.localizable !== false;
}

export function russianKeysButton(env: FormEnv): HTMLElement | null {
    if (env.readOnly || !localizable(env)) return null;
    const t = env.t;
    const localizer = localizerApi(env.app);
    const canon = canonApi(env.app);

    if (localizer) {
        return el('div', { class: 'maestro-m23f-actions' }, [
            button({
                label: t('m23f.ru.localizer'),
                icon: 'fa-language',
                title: t('m23f.ru.localizerHint'),
                onClick: async () => {
                    if (env.isDirty()) {
                        env.status(t('m23f.ru.saveFirst'), 'warn');
                        return;
                    }
                    env.status(t('m23f.ru.working'));
                    let result: { added?: unknown; failures?: unknown } | undefined;
                    try {
                        result = await localizer.localizeEntries(env.ctx.book, [env.ctx.uid]);
                    } catch (error) {
                        env.status(
                            t('m23f.ru.failed', { error: error instanceof Error ? error.message : String(error) }),
                            'error',
                        );
                        return;
                    }
                    // The Localizer wrote the book itself: show the entry as it is now.
                    await env.reload();
                    const added = typeof result?.added === 'number' ? result.added : 0;
                    const failures = typeof result?.failures === 'number' ? result.failures : 0;
                    if (failures) env.status(t('m23f.ru.localizerFailed', { added, failures }), 'warn');
                    else if (added) env.status(t('m23f.ru.localizerDone', { added }), 'ok');
                    else env.status(t('m23f.ru.nothingNew'), 'info');
                },
            }),
        ]);
    }

    if (canon) {
        return el('div', { class: 'maestro-m23f-actions' }, [
            button({
                label: t('m23f.ru.forms'),
                icon: 'fa-language',
                title: t('m23f.ru.formsHint'),
                onClick: async () => {
                    const keys = stringList(env.state.draft.key);
                    const terms = englishTerms(keys);
                    if (!terms.length) {
                        env.status(t('m23f.ru.noTerms'), 'info');
                        return;
                    }
                    env.status(t('m23f.ru.working'));
                    const forms: string[] = [];
                    for (const term of terms) {
                        try {
                            forms.push(...(await canon.russianKeys(term)));
                        } catch (error) {
                            env.app.log.debug('russianKeys failed', term, error);
                        }
                    }
                    const merged = mergeKeys(keys, forms);
                    const added = merged.length - keys.length;
                    if (!added) {
                        env.status(t('m23f.ru.nothingNew'), 'info');
                        return;
                    }
                    env.state.draft.key = merged;
                    env.changed();
                    env.status(t('m23f.ru.added', { count: added }), 'ok');
                },
            }),
        ]);
    }

    return el('div', { class: 'maestro-m23f-actions' }, [
        button({ label: t('m23f.ru.forms'), icon: 'fa-language', disabled: true, title: t('m23f.ru.unavailable') }),
        el('span', { class: 'maestro-m23f-hint', text: t('m23f.ru.unavailable') }),
    ]);
}
