// «Вкладка устарела» banner (plan M4 п. 4): persistent while the tab is stale, with what is held, what this tab
// would overwrite, and the two ways out. Owned by M4; text nodes only (keys of other extensions are data).
import { button, el } from '../../ui/components/dom';
import type { GuardInfo, SaveKind } from './tab-guard';

type Translate = (key: string, params?: Record<string, string | number>) => string;

export const BANNER_ID = 'maestro-guardian-banner';
const SHOWN_KEYS = 8;

export const BANNER_CSS = `
#${BANNER_ID} {
    position: fixed;
    top: calc(var(--topBarBlockSize, 40px) + 8px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 30000;
    width: min(680px, calc(100vw - 16px));
    max-height: 60vh;
    overflow: auto;
    box-sizing: border-box;
    padding: 12px 14px;
    border-radius: var(--maestro-radius, 10px);
    border-left: 4px solid var(--maestro-warn, rgb(230, 170, 40));
    background: var(--maestro-surface, rgb(23, 23, 23));
    color: var(--maestro-text, rgb(220, 220, 210));
    box-shadow: 0 4px 18px var(--maestro-shadow, rgba(0, 0, 0, 0.5));
    font-size: var(--maestro-font-size, 15px);
}
#${BANNER_ID} .maestro-guardian-title { font-weight: 600; margin-bottom: 4px; }
#${BANNER_ID} .maestro-guardian-line { margin: 4px 0; color: var(--maestro-muted, rgb(145, 145, 145)); }
#${BANNER_ID} .maestro-guardian-keys { margin: 4px 0 0; padding-left: 18px; word-break: break-word; }
#${BANNER_ID} .maestro-guardian-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
`;

const KINDS: readonly SaveKind[] = ['settings', 'preset', 'worldinfo'];

export interface BannerActions {
    reload(): void;
    saveAnyway(): void;
}

function counts(t: Translate, values: Record<SaveKind, number>): string {
    return KINDS.filter((kind) => values[kind] > 0)
        .map((kind) => `${t(`m4.kind.${kind}`)} — ${values[kind]}`)
        .join(', ');
}

export class StaleBanner {
    private node: HTMLElement | null = null;

    constructor(
        private readonly t: Translate,
        private readonly actions: BannerActions,
    ) {}

    render(info: GuardInfo): void {
        if (info.state !== 'stale') {
            this.remove();
            return;
        }
        if (typeof document === 'undefined') return;
        const { t } = this;
        const held = counts(t, info.held);
        const vetoed = counts(t, info.vetoed);
        const shown = info.overwrites.slice(0, SHOWN_KEYS);
        const more = info.overwrites.length - shown.length;
        const node = el('div', { attrs: { id: BANNER_ID, role: 'alert' } }, [
            el('div', { class: 'maestro-guardian-title', text: t('m4.banner.title') }),
            el('div', { class: 'maestro-guardian-line', text: t('m4.banner.text') }),
            held ? el('div', { class: 'maestro-guardian-line', text: t('m4.banner.held', { list: held }) }) : null,
            vetoed
                ? el('div', { class: 'maestro-guardian-line', text: t('m4.banner.vetoed', { list: vetoed }) })
                : null,
            shown.length
                ? el('div', { class: 'maestro-guardian-line' }, [
                      t('m4.banner.overwrites'),
                      el('ul', { class: 'maestro-guardian-keys' }, [
                          ...shown.map((key) => el('li', { text: key })),
                          more > 0 ? el('li', { text: t('m4.banner.more', { count: more }) }) : null,
                      ]),
                  ])
                : null,
            el('div', { class: 'maestro-guardian-actions' }, [
                button({
                    label: t('m4.banner.reload'),
                    icon: 'fa-rotate-right',
                    kind: 'primary',
                    onClick: () => this.actions.reload(),
                }),
                button({
                    label: t('m4.banner.saveAnyway'),
                    icon: 'fa-floppy-disk',
                    kind: 'danger',
                    title: t('m4.banner.saveAnywayHint'),
                    onClick: () => this.actions.saveAnyway(),
                }),
            ]),
        ]);
        if (this.node?.isConnected) this.node.replaceWith(node);
        else document.body.appendChild(node);
        this.node = node;
    }

    remove(): void {
        this.node?.remove();
        this.node = null;
    }
}
