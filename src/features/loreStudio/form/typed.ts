// Typed entries (plan M23 new possibility 1): a type with its field template; Maestro-owned and canon books keep
// `{type, fields}` in `entry.extensions.maestro`, base books in the bookRoles sidecar (P2) so their files stay as
// the author made them. «Собрать содержимое из полей» composes the content but never replaces existing text
// without asking.
import {
    ENTRY_TYPES,
    ENTRY_TYPE_IDS,
    composeContent,
    emptyFields,
    fieldsFromContent,
    isEntryType,
    templateValues,
    withTypedMeta,
} from '../../../domain/entry-types';
import type { TypedEntryMeta } from '../../../domain/entry-types';
import { uid as domId } from '../../../ui/components/controls';
import { button, el } from '../../../ui/components/dom';
import { diffView } from '../../../ui/components/diff';
import { disableAll, row } from './controls';
import type { FormEnv } from './env';

/** Writes the working typed meta into the draft when the entry itself stores it. */
export function applyTyped(env: FormEnv): void {
    if (env.state.typedStorage === 'entry') {
        const next = withTypedMeta(env.state.draft.extensions, env.state.typed);
        if (next === undefined) delete env.state.draft.extensions;
        else env.state.draft.extensions = next;
    }
    env.changed();
}

async function compose(env: FormEnv, meta: TypedEntryMeta): Promise<void> {
    const t = env.t;
    const composed = composeContent(meta);
    if (!composed) {
        env.status(t('m23f.typed.emptyFields'), 'info');
        return;
    }
    const current = typeof env.state.draft.content === 'string' ? env.state.draft.content : '';
    if (current === composed) {
        env.status(t('m23f.typed.same'), 'info');
        return;
    }
    if (current.trim()) {
        const body = el('div', { class: 'maestro-m23f-confirm' }, [
            el('p', { text: t('m23f.typed.replaceBody') }),
            diffView(current, composed, t),
        ]);
        if (!(await env.app.ui.confirm(t('m23f.typed.replaceTitle'), body))) return;
    }
    env.state.draft.content = composed;
    env.changed();
    env.status(t('m23f.typed.composed'), 'ok');
}

export function typedBlock(env: FormEnv): HTMLElement {
    const t = env.t;
    const storage = env.state.typedStorage;
    const box = el('div', { class: 'maestro-m23f-typed', data: { block: 'typed' } });
    if (storage === 'none' && !env.state.typed) {
        box.append(el('div', { class: 'maestro-m23f-hint', text: t('m23f.typed.unavailable') }));
        return box;
    }

    const id = domId('maestro-m23f-type');
    const picker = el('select', { class: 'text_pole', attrs: { id, name: 'entryType' } }, [
        el('option', { text: t('m23f.typed.none'), attrs: { value: '' } }),
        ...ENTRY_TYPE_IDS.map((type) => el('option', { text: t(`m23f.type.${type}`), attrs: { value: type } })),
    ]);
    picker.value = env.state.typed?.type ?? '';
    const fields = el('div', { class: 'maestro-m23f-typed-fields' });
    const composeButton = button({
        label: t('m23f.typed.compose'),
        icon: 'fa-wand-magic-sparkles',
        title: t('m23f.typed.composeHint'),
        onClick: async () => {
            if (env.state.typed) await compose(env, env.state.typed);
        },
    });

    const renderFields = () => {
        const meta = env.state.typed;
        composeButton.hidden = !meta;
        if (!meta) {
            fields.replaceChildren();
            return;
        }
        const values = templateValues(meta);
        fields.replaceChildren(
            ...ENTRY_TYPES[meta.type].fields.map((field) => {
                const fieldId = domId('maestro-m23f-tf');
                const input = field.multiline
                    ? el('textarea', { class: 'text_pole maestro-m23f-textarea', attrs: { id: fieldId, rows: 2 } })
                    : el('input', { class: 'text_pole', attrs: { id: fieldId, type: 'text', autocomplete: 'off' } });
                input.value = values[field.id] ?? '';
                input.dataset.typedField = field.id;
                input.addEventListener('input', () => {
                    const current = env.state.typed;
                    if (!current) return;
                    env.state.typed = { type: current.type, fields: { ...current.fields, [field.id]: input.value } };
                    applyTyped(env);
                });
                return row(env, { label: t(`m23f.tf.${field.id}`), control: input, for: fieldId });
            }),
        );
    };

    picker.addEventListener('change', () => {
        const value = picker.value;
        const previous = env.state.typed;
        if (!isEntryType(value)) {
            env.state.typed = null;
        } else if (previous?.type === value) {
            return;
        } else {
            const content = typeof env.state.draft.content === 'string' ? env.state.draft.content : '';
            env.state.typed = {
                type: value,
                fields: content.trim() ? fieldsFromContent(value, content) : emptyFields(value),
            };
        }
        renderFields();
        applyTyped(env);
    });
    renderFields();

    box.append(
        row(env, {
            label: t('m23f.typed.label'),
            control: picker,
            for: id,
            hint: t(storage === 'sidecar' ? 'm23f.typed.whereSidecar' : 'm23f.typed.whereEntry'),
        }),
        fields,
        el('div', { class: 'maestro-m23f-actions' }, [composeButton]),
    );
    if (storage === 'none') {
        // Shown for information only: without the roles module there is nowhere to keep a base entry's type (P2).
        disableAll(box);
        box.append(el('div', { class: 'maestro-m23f-hint', text: t('m23f.typed.unavailable') }));
    }
    return box;
}
