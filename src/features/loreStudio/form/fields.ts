// Field sections of the entry form with ST 1.19 semantics (research/parity-lore.md §3): «Размещение» (status,
// position + role, depth, outlet, order), «Активация и рекурсия» (probability, scan depth, tri-states, recursion
// flags, budget), «Таймеры», «Группы», «Источники сканирования» and «Служебное» (UID, automation id, hidden flags,
// what ST's own editor would change on open, unknown fields).
import {
    DEFAULT_DEPTH,
    DEFAULT_ORDER,
    DEFAULT_PROBABILITY,
    DEFAULT_WEIGHT,
    MATCH_FLAGS,
    POSITION_OPTIONS,
    WI_POSITION,
    applyEntryState,
    applyPosition,
    bookSuggestions,
    entryState,
    groupNames,
    isKnownPosition,
    positionOptionId,
    recursionDelayFromLevel,
    recursionDelayView,
    stEditorDifferences,
    toggleRecursionDelay,
} from '../../../domain/lore-form-fields';
import type { EntryState } from '../../../domain/lore-form-fields';
import { uid as domId } from '../../../ui/components/controls';
import { button, el } from '../../../ui/components/dom';
import { formatValue } from '../../../ui/components/diff';
import { checkField, formSection, note, numberField, row, suggestionChips, textField, triField } from './controls';
import { GLOBAL_NAMES, globalValue } from './env';
import type { FormEnv } from './env';

function entries(env: FormEnv): Record<string, unknown>[] {
    return Object.values(env.state.data.entries ?? {}) as Record<string, unknown>[];
}

/** Shows `node` only while `visible()` holds (re-checked after every change). */
function showWhen(env: FormEnv, node: HTMLElement, visible: () => boolean): HTMLElement {
    const apply = () => {
        node.hidden = !visible();
    };
    apply();
    env.sync(apply);
    return node;
}

/** A note that appears while `text()` returns a string. */
function liveNote(env: FormEnv, text: () => string | null, level: 'info' | 'warn' = 'warn'): HTMLElement {
    const holder = el('div');
    const apply = () => {
        const value = text();
        holder.replaceChildren(...(value ? [note(value, level)] : []));
    };
    apply();
    env.sync(apply);
    return holder;
}

/* ------------------------------------------------------------------ placement */

function statusSelect(env: FormEnv): HTMLElement {
    const t = env.t;
    const id = domId('maestro-m23f-state');
    const states: EntryState[] = ['constant', 'normal', 'vectorized'];
    const node = el(
        'select',
        { class: 'text_pole', attrs: { id, name: 'entryState' } },
        states.map((state) => el('option', { text: t(`m23f.state.${state}`), attrs: { value: state } })),
    );
    node.value = entryState(env.state.draft);
    node.addEventListener('change', () => {
        Object.assign(env.state.draft, applyEntryState(node.value as EntryState));
        env.changed();
    });
    return row(env, { label: t('m23f.state.label'), control: node, for: id, hint: t('m23f.state.hint') });
}

function positionSelect(env: FormEnv): HTMLElement {
    const t = env.t;
    const id = domId('maestro-m23f-position');
    const current = positionOptionId(env.state.draft.position, env.state.draft.role);
    const options = POSITION_OPTIONS.map((option) =>
        el('option', { text: t(`m23f.pos.${option.name}`), attrs: { value: option.id } }),
    );
    if (!isKnownPosition(current)) {
        options.push(el('option', { text: t('m23f.pos.other', { value: current }), attrs: { value: current } }));
    }
    const node = el('select', { class: 'text_pole', attrs: { id, name: 'position' } }, options);
    node.value = current;
    node.addEventListener('change', () => {
        Object.assign(env.state.draft, applyPosition(node.value));
        env.changed();
    });
    return row(env, {
        label: t('m23f.pos.label'),
        control: node,
        for: id,
        hint: [
            liveNote(env, () => (env.state.draft.position === undefined ? t('m23f.pos.missing') : null), 'warn'),
            liveNote(
                env,
                () => {
                    const position = env.state.draft.position;
                    return position === WI_POSITION.ANTop || position === WI_POSITION.ANBottom
                        ? t('m23f.pos.anHint')
                        : null;
                },
                'info',
            ),
        ],
    });
}

function outletRow(env: FormEnv): HTMLElement {
    const t = env.t;
    const suggestions = bookSuggestions(entries(env), 'outletName', env.ctx.uid);
    const { node } = textField(env, 'outletName', {
        label: t('m23f.outlet.label'),
        placeholder: t('m23f.outlet.placeholder'),
        suggestions,
        hint: [
            el('span', { text: t('m23f.outlet.hint') }),
            liveNote(env, () =>
                env.state.draft.position === WI_POSITION.outlet && !String(env.state.draft.outletName ?? '').trim()
                    ? t('m23f.outlet.empty')
                    : null,
            ),
        ],
    });
    return showWhen(
        env,
        node,
        () => env.state.draft.position === WI_POSITION.outlet || String(env.state.draft.outletName ?? '').trim() !== '',
    );
}

export function placementSection(env: FormEnv): HTMLElement {
    const t = env.t;
    const depth = numberField(env, 'depth', {
        label: t('m23f.depth.label'),
        placeholder: String(DEFAULT_DEPTH),
        hint: t('m23f.depth.hint'),
    }).node;
    return formSection(
        t('m23f.section.placement'),
        [
            statusSelect(env),
            positionSelect(env),
            showWhen(env, depth, () => env.state.draft.position === WI_POSITION.atDepth),
            outletRow(env),
            numberField(env, 'order', {
                label: t('m23f.order.label'),
                placeholder: String(DEFAULT_ORDER),
                hint: t('m23f.order.hint'),
            }).node,
        ],
        { id: 'placement' },
    );
}

/* ------------------------------------------------------------------ activation and recursion */

function probabilityRows(env: FormEnv): HTMLElement[] {
    const t = env.t;
    const probability = numberField(env, 'probability', {
        label: t('m23f.prob.label'),
        placeholder: String(DEFAULT_PROBABILITY),
        hint: [
            liveNote(env, () => {
                const draft = env.state.draft;
                if (draft.useProbability === true && typeof draft.probability !== 'number') return t('m23f.prob.empty');
                return null;
            }),
            liveNote(env, () => {
                const draft = env.state.draft;
                if (draft.useProbability === true) return null;
                const value = typeof draft.probability === 'number' ? draft.probability : null;
                return value !== null && value < 100 ? t('m23f.prob.notRolled', { value }) : null;
            }),
        ],
    });
    const use = checkField(env, 'useProbability', {
        label: t('m23f.prob.use'),
        hint: t('m23f.prob.useHint'),
    });
    return [probability.node, use.node];
}

function recursionRows(env: FormEnv): HTMLElement[] {
    const t = env.t;
    const view = recursionDelayView(env.state.draft.delayUntilRecursion);
    const levelId = domId('maestro-m23f-level');
    const level = el('input', {
        class: 'text_pole maestro-m23f-number',
        attrs: {
            id: levelId,
            type: 'text',
            inputmode: 'numeric',
            name: 'delayUntilRecursionLevel',
            autocomplete: 'off',
        },
    });
    level.value = view.level;
    level.placeholder = t('m23f.rec.levelPlaceholder');
    level.addEventListener('input', () => {
        const result = recursionDelayFromLevel(env.state.draft.delayUntilRecursion, level.value);
        if (!result.ok) {
            env.setError('delayUntilRecursion', t('m23f.rec.levelInvalid'));
            env.changed();
            return;
        }
        env.setError('delayUntilRecursion', null);
        env.state.draft.delayUntilRecursion = result.value;
        env.changed();
    });
    const delayId = domId('maestro-m23f-delay-rec');
    const delay = el('input', { attrs: { type: 'checkbox', id: delayId, name: 'delayUntilRecursion' } });
    delay.checked = view.on;
    delay.addEventListener('change', () => {
        env.state.draft.delayUntilRecursion = toggleRecursionDelay(env.state.draft.delayUntilRecursion, delay.checked);
        if (!delay.checked) {
            level.value = '';
            env.setError('delayUntilRecursion', null);
        }
        env.changed();
    });
    const levelRow = row(env, {
        label: t('m23f.rec.level'),
        control: level,
        for: levelId,
        hint: t('m23f.rec.levelHint'),
        field: 'delayUntilRecursion',
    });
    return [
        checkField(env, 'excludeRecursion', { label: t('m23f.rec.exclude'), hint: t('m23f.rec.excludeHint') }).node,
        checkField(env, 'preventRecursion', { label: t('m23f.rec.prevent'), hint: t('m23f.rec.preventHint') }).node,
        el('div', { class: 'maestro-m23f-check' }, [
            el('label', { class: 'checkbox_label', attrs: { for: delayId } }, [
                delay,
                el('span', { text: t('m23f.rec.delay') }),
            ]),
            el('div', { class: 'maestro-m23f-hint', text: t('m23f.rec.delayHint') }),
        ]),
        showWhen(env, levelRow, () => !!env.state.draft.delayUntilRecursion || level.value !== ''),
    ];
}

export function activationSection(env: FormEnv): HTMLElement {
    const t = env.t;
    const globals = env.state.globals;
    const scanGlobal = globalValue(globals, [...GLOBAL_NAMES.scanDepth], 'number');
    return formSection(
        t('m23f.section.activation'),
        [
            ...probabilityRows(env),
            numberField(env, 'scanDepth', {
                label: t('m23f.scan.label'),
                placeholder:
                    scanGlobal === undefined ? t('m23f.scan.global') : t('m23f.scan.globalNow', { value: scanGlobal }),
                hint: t('m23f.scan.hint'),
            }).node,
            triField(
                env,
                'caseSensitive',
                t('m23f.case.label'),
                globalValue(globals, [...GLOBAL_NAMES.caseSensitive], 'boolean'),
                t('m23f.case.hint'),
            ),
            triField(
                env,
                'matchWholeWords',
                t('m23f.whole.label'),
                globalValue(globals, [...GLOBAL_NAMES.matchWholeWords], 'boolean'),
                t('m23f.whole.hint'),
            ),
            ...recursionRows(env),
            checkField(env, 'ignoreBudget', { label: t('m23f.budget.ignore'), hint: t('m23f.budget.ignoreHint') }).node,
        ],
        { id: 'activation' },
    );
}

/* ------------------------------------------------------------------ timers */

function hasValue(value: unknown): boolean {
    return typeof value === 'number' && value !== 0;
}

export function timersSection(env: FormEnv): HTMLElement {
    const t = env.t;
    const draft = env.state.draft;
    return formSection(
        t('m23f.section.timers'),
        [
            numberField(env, 'sticky', {
                label: t('m23f.timer.sticky'),
                placeholder: t('m23f.timer.none'),
                hint: t('m23f.timer.stickyHint'),
            }).node,
            numberField(env, 'cooldown', {
                label: t('m23f.timer.cooldown'),
                placeholder: t('m23f.timer.none'),
                hint: t('m23f.timer.cooldownHint'),
            }).node,
            numberField(env, 'delay', {
                label: t('m23f.timer.delay'),
                placeholder: t('m23f.timer.none'),
                hint: t('m23f.timer.delayHint'),
            }).node,
            liveNote(
                env,
                () =>
                    hasValue(env.state.stored.sticky) || hasValue(env.state.stored.cooldown)
                        ? t('m23f.timer.hashReset')
                        : null,
                'info',
            ),
        ],
        { id: 'timers', open: hasValue(draft.sticky) || hasValue(draft.cooldown) || hasValue(draft.delay) },
    );
}

/* ------------------------------------------------------------------ groups */

export function groupsSection(env: FormEnv): HTMLElement {
    const t = env.t;
    const suggestions = bookSuggestions(entries(env), 'group', env.ctx.uid);
    const group = textField(env, 'group', {
        label: t('m23f.group.label'),
        placeholder: t('m23f.group.placeholder'),
        trim: true,
        hint: t('m23f.group.hint'),
    });
    const chipsHolder = el('div');
    const renderChips = () => {
        const present = new Set(groupNames(env.state.draft.group).map((name) => name.trim()));
        const free = suggestions.filter((name) => !present.has(name)).slice(0, 12);
        const chips = env.readOnly
            ? null
            : suggestionChips(free, t('m23f.group.suggest'), (name) => {
                  const current = String(env.state.draft.group ?? '').trim();
                  const next = current ? `${current},${name}` : name;
                  group.input.value = next;
                  env.state.draft.group = next;
                  env.changed();
              });
        chipsHolder.replaceChildren(...(chips ? [chips] : []));
    };
    renderChips();
    env.sync(renderChips);
    const draft = env.state.draft;
    return formSection(
        t('m23f.section.groups'),
        [
            group.node,
            chipsHolder,
            checkField(env, 'groupOverride', { label: t('m23f.group.override'), hint: t('m23f.group.overrideHint') })
                .node,
            numberField(env, 'groupWeight', {
                label: t('m23f.group.weight'),
                placeholder: String(DEFAULT_WEIGHT),
                hint: t('m23f.group.weightHint'),
            }).node,
            triField(
                env,
                'useGroupScoring',
                t('m23f.group.scoring'),
                globalValue(env.state.globals, [...GLOBAL_NAMES.useGroupScoring], 'boolean'),
                t('m23f.group.scoringHint'),
            ),
        ],
        { id: 'groups', open: groupNames(draft.group).length > 0 },
    );
}

/* ------------------------------------------------------------------ scan sources */

export function sourcesSection(env: FormEnv): HTMLElement {
    const t = env.t;
    const draft = env.state.draft;
    return formSection(
        t('m23f.section.sources'),
        [
            el('div', { class: 'maestro-m23f-hint', text: t('m23f.src.hint') }),
            ...MATCH_FLAGS.map((flag) => checkField(env, flag, { label: t(`m23f.src.${flag}`) }).node),
        ],
        { id: 'sources', open: MATCH_FLAGS.some((flag) => draft[flag] === true) },
    );
}

/* ------------------------------------------------------------------ service */

/** Fields ST's editor knows (anything else belongs to other extensions and is kept as is). */
const KNOWN_FIELDS = new Set([
    'uid',
    'key',
    'keysecondary',
    'comment',
    'content',
    'constant',
    'vectorized',
    'selective',
    'selectiveLogic',
    'addMemo',
    'order',
    'position',
    'disable',
    'ignoreBudget',
    'excludeRecursion',
    'preventRecursion',
    'matchPersonaDescription',
    'matchCharacterDescription',
    'matchCharacterPersonality',
    'matchCharacterDepthPrompt',
    'matchScenario',
    'matchCreatorNotes',
    'delayUntilRecursion',
    'probability',
    'useProbability',
    'depth',
    'outletName',
    'group',
    'groupOverride',
    'groupWeight',
    'scanDepth',
    'caseSensitive',
    'matchWholeWords',
    'useGroupScoring',
    'automationId',
    'role',
    'sticky',
    'cooldown',
    'delay',
    'triggers',
    'characterFilter',
    'displayIndex',
    'extensions',
]);

function differencesBlock(env: FormEnv): HTMLElement {
    const t = env.t;
    const holder = el('div', { class: 'maestro-m23f-diffs' });
    const render = () => {
        const list = stEditorDifferences(env.state.draft);
        if (!list.length) {
            holder.replaceChildren(el('div', { class: 'maestro-m23f-hint', text: t('m23f.st.none') }));
            return;
        }
        holder.replaceChildren(
            el('div', { class: 'maestro-m23f-hint', text: t('m23f.st.intro') }),
            el(
                'ul',
                { class: 'maestro-m23f-list' },
                list.map((item) =>
                    el('li', { class: item.engine ? 'maestro-warn-text' : undefined }, [
                        el('code', { text: item.field }),
                        el('span', {
                            text: ` ${formatValue(item.stored)} → ${formatValue(item.st)}`,
                        }),
                        item.engine ? el('span', { class: 'maestro-m23f-tag', text: t('m23f.st.engine') }) : null,
                    ]),
                ),
            ),
        );
    };
    render();
    env.sync(render);
    return holder;
}

export function serviceSection(env: FormEnv): HTMLElement {
    const t = env.t;
    const draft = env.state.draft;
    const unknown = Object.keys(draft).filter((key) => !KNOWN_FIELDS.has(key));
    const automation = textField(env, 'automationId', {
        label: t('m23f.svc.automation'),
        placeholder: t('m23f.svc.automationNone'),
        suggestions: bookSuggestions(entries(env), 'automationId', env.ctx.uid),
        hint: t('m23f.svc.automationHint'),
    });
    const selective = checkField(env, 'selective', {
        label: t('m23f.svc.selective'),
        hint: t('m23f.svc.selectiveHint'),
    });
    const addMemo = checkField(env, 'addMemo', { label: t('m23f.svc.addMemo'), hint: t('m23f.svc.addMemoHint') });
    const card = env.state.data.originalData !== undefined;
    return formSection(
        t('m23f.section.service'),
        [
            el('div', { class: 'maestro-kv' }, [
                el('span', { text: t('m23f.svc.uid') }),
                el('code', { class: 'maestro-m23f-uid', text: String(env.ctx.uid) }),
            ]),
            automation.node,
            selective.node,
            addMemo.node,
            card ? note(t('m23f.svc.cardBook')) : null,
            el(
                'details',
                { class: 'maestro-m23f-help', attrs: { open: stEditorDifferences(draft).some((d) => d.engine) } },
                [el('summary', { text: t('m23f.st.title') }), differencesBlock(env)],
            ),
            unknown.length
                ? el('div', { class: 'maestro-m23f-hint', text: t('m23f.svc.unknown', { fields: unknown.join(', ') }) })
                : null,
            el('div', { class: 'maestro-m23f-hint', text: t('m23f.svc.unknownKept') }),
        ].filter((node): node is HTMLElement => node !== null),
        { id: 'service', open: false },
    );
}

/** Quick row at the top: enabled toggle. */
export function enabledToggle(env: FormEnv): HTMLElement {
    return checkField(env, 'disable', { label: env.t('m23f.enabled'), invert: true }).node;
}

/** The passport section (M28) lives in passport.ts. */
export { passportSection } from './passport';

/** «Сделать как в ST» shortcut for the engine-relevant hidden switches (selective / useProbability). */
export function stFixButton(env: FormEnv): HTMLElement | null {
    if (env.readOnly) return null;
    return button({
        label: env.t('m23f.st.apply'),
        kind: 'ghost',
        title: env.t('m23f.st.applyHint'),
        onClick: () => {
            const draft = env.state.draft;
            draft.selective = true;
            draft.useProbability = true;
            if (typeof draft.probability !== 'number') draft.probability = DEFAULT_PROBABILITY;
            env.changed();
        },
    });
}
