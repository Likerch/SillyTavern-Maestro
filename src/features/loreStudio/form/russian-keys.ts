// «Русские ключи» (plan M23 new possibility 7): the Lorebook Localizer localizes this entry without its dialog when
// its API is there (it writes the book itself and marks the keys it added); otherwise the canon module's Russian
// forms (DES-RU declensions) of every English key are appended to the draft as a new array. Never for BunnyMo
// books (P13: no Russian keys in packs) or books whose role is not localizable.
// The Localizer path is a user job (plan-2 §8, localize-job.ts): a compact inline status (waiting / translating /
// result, «Stop» with Localizer 0.3) that survives closing and reopening the form; the button cannot start a twin.
import type { LocalizerApi } from '../../../adapters/localizer';
import { englishTerms, mergeKeys, stringList } from '../../../domain/lore-form-keys';
import { button, el } from '../../../ui/components/dom';
import type { UserJobInfo } from '../../../shared/contracts';
import { userJobs, watchJob, isJobWatched } from '../jobs';
import { entryJobKey, startLocalizeJob } from '../localize-job';
import { renderJobInline } from '../view-job';
import { canonApi, entryLabel, localizerApi } from './env';
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

    if (localizer) return localizerControl(env, localizer);

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

/** The Localizer button with the inline status of this entry's job. */
function localizerControl(env: FormEnv, localizer: LocalizerApi): HTMLElement {
    const t = env.t;
    const { app, ctx } = env;
    const jobs = userJobs(app);
    const key = entryJobKey(ctx.book, ctx.uid);
    const status = el('span', { class: 'maestro-m23f-job' });

    const start = (uids: number[]) => {
        startLocalizeJob({
            app,
            jobs,
            api: localizer,
            scope: 'entry',
            book: ctx.book,
            uids,
            titles: { [ctx.uid]: entryLabel({ ...env.state.stored, uid: ctx.uid }) },
            visible: () => isJobWatched(key),
        });
    };
    const trigger = button({
        label: t('m23f.ru.localizer'),
        icon: 'fa-language',
        title: t('m23f.ru.localizerHint'),
        className: 'maestro-m23f-localize',
        onClick: () => {
            if (env.isDirty()) {
                env.status(t('m23f.ru.saveFirst'), 'warn');
                return;
            }
            if (jobs.get(key)?.state === 'active') return;
            start([ctx.uid]);
        },
    });

    const draw = (job: UserJobInfo | undefined) => {
        trigger.hidden = job?.state === 'active';
        status.replaceChildren(
            ...(job
                ? [
                      renderJobInline(app, job, {
                          stop: () => {
                              jobs.cancel(key);
                          },
                          retry: (uids) => {
                              if (env.isDirty()) env.status(t('m23f.ru.saveFirst'), 'warn');
                              else start(uids);
                          },
                          dismiss: () => jobs.dismiss(key),
                      }),
                  ]
                : []),
        );
    };

    let last = jobs.get(key);
    env.own(watchJob(key));
    env.own(
        jobs.on((job, changed) => {
            if (changed !== key) return;
            const finished = last?.state === 'active' && job !== undefined && job.state !== 'active';
            last = job;
            draw(job);
            // The Localizer wrote the book: show the entry as it is now (unless the user started editing meanwhile —
            // the form then warns about the outside change itself).
            if (finished && job.state !== 'failed' && !env.isDirty()) void env.reload();
        }),
    );
    draw(last);
    return el('div', { class: 'maestro-m23f-actions' }, [trigger, status]);
}
