// «Содержимое»: title/memo (placeholder = primary keys like ST, L-054), content with a live token counter
// (getTokenCountAsync, 1 s after the last edit like ST, L-075), «expand» (L-076), decorators hint (L-103) and the
// typed-entry block (plan M23 new possibility 1).
import { analyzeDecorators, stringList } from '../../../domain/lore-form-keys';
import { commentPlaceholder } from '../../../domain/lore-form-fields';
import { uid as domId } from '../../../ui/components/controls';
import { button, el } from '../../../ui/components/dom';
import { formSection, note, row } from './controls';
import type { FormEnv } from './env';
import { typedBlock } from './typed';

/** ST counts tokens 1 s after the last edit (`debounce_timeout.relaxed`). */
export const TOKEN_DEBOUNCE_MS = 1000;

function commentField(env: FormEnv): HTMLElement {
    const t = env.t;
    const id = domId('maestro-m23f-comment');
    const input = el('textarea', {
        class: 'text_pole maestro-m23f-textarea',
        attrs: { id, rows: 1, name: 'comment' },
    });
    input.value = typeof env.state.draft.comment === 'string' ? env.state.draft.comment : '';
    input.addEventListener('input', () => {
        const draft: Record<string, unknown> = env.state.draft;
        if (input.value === '' && env.state.stored.comment === undefined) delete draft.comment;
        else draft.comment = input.value;
        env.changed();
    });
    const placeholder = () => {
        input.placeholder = commentPlaceholder(stringList(env.state.draft.key)) || t('m23f.comment.placeholder');
    };
    placeholder();
    env.sync(placeholder);
    return row(env, { label: t('m23f.comment.label'), control: input, for: id, hint: t('m23f.comment.hint') });
}

function decoratorNotes(env: FormEnv): HTMLElement {
    const t = env.t;
    const holder = el('div', { class: 'maestro-m23f-notes' });
    const render = () => {
        const content = typeof env.state.draft.content === 'string' ? env.state.draft.content : '';
        const info = analyzeDecorators(content);
        const notes: HTMLElement[] = [];
        if (info.known.includes('@@activate')) notes.push(note(t('m23f.deco.activate')));
        if (info.known.includes('@@dont_activate')) notes.push(note(t('m23f.deco.dontActivate'), 'warn'));
        if (info.unknown.length) notes.push(note(t('m23f.deco.unknown', { lines: info.unknown.join(' · ') }), 'warn'));
        holder.replaceChildren(...notes);
    };
    render();
    env.sync(render);
    return holder;
}

function contentField(env: FormEnv): HTMLElement {
    const t = env.t;
    const id = domId('maestro-m23f-content');
    const input = el('textarea', {
        class: 'text_pole maestro-m23f-textarea maestro-m23f-content',
        attrs: { id, rows: 8, name: 'content', placeholder: t('m23f.content.placeholder') },
    });
    input.value = typeof env.state.draft.content === 'string' ? env.state.draft.content : '';
    const tokens = el('span', { class: 'maestro-m23f-tokens', text: t('m23f.content.tokens', { count: '…' }) });
    const chars = el('span', { class: 'maestro-m23f-chars' });

    let timer: ReturnType<typeof setTimeout> | null = null;
    let generation = 0;
    let alive = true;
    env.own(() => {
        alive = false;
        if (timer !== null) clearTimeout(timer);
        timer = null;
    });
    const count = async () => {
        const text = input.value;
        const mine = ++generation;
        try {
            const value = await env.app.host.ctx().getTokenCountAsync(text);
            if (alive && mine === generation) tokens.textContent = t('m23f.content.tokens', { count: value });
        } catch (error) {
            env.app.log.debug('token count failed', error);
            if (alive && mine === generation) tokens.textContent = t('m23f.content.tokens', { count: '?' });
        }
    };
    const schedule = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void count();
        }, TOKEN_DEBOUNCE_MS);
    };
    const updateChars = () => {
        chars.textContent = t('m23f.content.chars', { count: input.value.length });
    };
    updateChars();
    void count();

    input.addEventListener('input', () => {
        const draft: Record<string, unknown> = env.state.draft;
        if (input.value === '' && env.state.stored.content === undefined) delete draft.content;
        else draft.content = input.value;
        updateChars();
        schedule();
        env.changed();
    });
    env.sync(() => {
        // Content replaced outside the textarea («Собрать из полей», history): show it and recount.
        const value = typeof env.state.draft.content === 'string' ? env.state.draft.content : '';
        if (value !== input.value) {
            input.value = value;
            updateChars();
            schedule();
        }
    });

    const expand = button({
        icon: 'fa-maximize',
        kind: 'ghost',
        title: t('m23f.content.expand'),
        className: 'maestro-m23f-expand',
        onClick: () => {
            const big = input.classList.toggle('maestro-m23f-content-big');
            expand.setAttribute('aria-pressed', big ? 'true' : 'false');
            input.focus();
        },
    });
    expand.setAttribute('aria-pressed', 'false');

    return row(env, {
        label: t('m23f.content.label'),
        control: input,
        for: id,
        field: 'content',
        hint: [
            el('div', { class: 'maestro-m23f-counter' }, [tokens, chars, expand]),
            decoratorNotes(env),
            el('details', { class: 'maestro-m23f-help' }, [
                el('summary', { text: t('m23f.deco.helpTitle') }),
                el('div', { class: 'maestro-m23f-hint', text: t('m23f.deco.help') }),
            ]),
        ],
    });
}

export function contentSection(env: FormEnv): HTMLElement {
    return formSection(env.t('m23f.section.content'), [commentField(env), contentField(env), typedBlock(env)], {
        id: 'content',
    });
}
