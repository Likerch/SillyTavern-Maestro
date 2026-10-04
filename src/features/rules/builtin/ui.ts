// Interface rules of stage 1 (plan M22 table, M32 п. 3; audit T19, T20; dev-plan 1.11). Neighbour DOM is styled
// only with stylesheets (plan §10.10): DES and CK rewrite inline styles of their nodes.
import type { Logger, Unsubscribe } from '../../../shared/contracts';
import type { RuleDefinition } from '../api';
import type { RuleEnv } from '../env';

export const CK_BUTTON_RULE_ID = 'ui.ckVectorizeButton';
export const DES_BAR_RULE_ID = 'ui.desPortraitBarMobile';

/** Same breakpoint as DES's own mobile rules (style.css `@media (max-width: 1000px)`). */
export const MOBILE_QUERY = '(max-width: 1000px)';

/**
 * CarrotKernel (fullsheet-rag.js addRAGButtonToMessage) appends «Vectorize Fullsheet» to `.mes` with inline
 * `position: absolute; top: 5px; right: 40px`, right over the ST and DES message buttons. The stylesheet moves it
 * to the bottom of the message (space is reserved under the text, left of the swipe counter), makes it compact and
 * hides it while the message is edited. `!important` beats CK's inline styles.
 */
export const CK_BUTTON_CSS = `
#chat .mes > .carrot-rag-fullsheet-button {
    top: auto !important;
    bottom: 4px !important;
    right: 90px !important;
    left: auto !important;
    padding: 2px 8px !important;
    font-size: 0.75em !important;
    gap: 4px !important;
    z-index: 2 !important;
    transform: none !important;
    box-shadow: none !important;
    opacity: 0.8;
}
#chat .mes > .carrot-rag-fullsheet-button:hover {
    opacity: 1;
}
#chat .mes:has(> .carrot-rag-fullsheet-button) .mes_block {
    padding-bottom: 26px;
}
#chat .mes:has(.edit_textarea) > .carrot-rag-fullsheet-button {
    display: none !important;
}
`;

/**
 * DES side modes (portraitBar.js: wrapper on <body>, `position: fixed`, full height, up to 400px of cards) have no
 * mobile rule. On narrow screens the panel becomes a bottom sheet above the send form with a limited height and a
 * horizontal strip of cards; collapsed, only DES's own toggle stays as a small pill. Top/above/below modes only get
 * a lower height limit.
 */
export const DES_PORTRAIT_BAR_CSS = `
@media ${MOBILE_QUERY} {
    #dooms-portrait-bar-wrapper.dooms-pb-position-left,
    #dooms-portrait-bar-wrapper.dooms-pb-position-right {
        top: auto !important;
        bottom: calc(var(--bottomFormBlockSize, 46px) + 8px) !important;
        left: 6px !important;
        right: 6px !important;
        width: auto !important;
        height: auto !important;
        max-height: min(45vh, 340px) !important;
        transform: none !important;
        flex-direction: column !important;
        border: 1px solid rgba(74, 123, 167, 0.4) !important;
        border-radius: 12px !important;
        overflow: hidden !important;
    }
    #dooms-portrait-bar-wrapper.dooms-pb-position-left .dooms-pb-toggle,
    #dooms-portrait-bar-wrapper.dooms-pb-position-right .dooms-pb-toggle {
        order: 0 !important;
        flex: 0 0 auto !important;
        width: auto !important;
        height: 30px !important;
        flex-direction: row !important;
        align-self: stretch !important;
        padding: 0 12px !important;
        border: none !important;
    }
    #dooms-portrait-bar-wrapper.dooms-pb-position-left .dooms-pb-toggle-label,
    #dooms-portrait-bar-wrapper.dooms-pb-position-right .dooms-pb-toggle-label {
        display: inline !important;
    }
    #dooms-portrait-bar-wrapper.dooms-pb-position-left .dooms-pb-toggle-chevron,
    #dooms-portrait-bar-wrapper.dooms-pb-position-right .dooms-pb-toggle-chevron {
        transform: rotate(180deg) !important;
    }
    #dooms-portrait-bar-wrapper.dooms-pb-collapsed-side.dooms-pb-position-left .dooms-pb-toggle-chevron,
    #dooms-portrait-bar-wrapper.dooms-pb-collapsed-side.dooms-pb-position-right .dooms-pb-toggle-chevron {
        transform: none !important;
    }
    #dooms-portrait-bar-wrapper.dooms-pb-position-left .dooms-portrait-bar,
    #dooms-portrait-bar-wrapper.dooms-pb-position-right .dooms-portrait-bar {
        order: 1 !important;
        flex: 1 1 auto !important;
        min-height: 0 !important;
        padding: 4px 8px 8px !important;
        overflow: hidden !important;
    }
    #dooms-portrait-bar-wrapper.dooms-pb-position-left .dooms-pb-header,
    #dooms-portrait-bar-wrapper.dooms-pb-position-right .dooms-pb-header {
        flex-direction: row !important;
        align-items: center !important;
        margin-bottom: 4px !important;
        padding: 0 2px 4px !important;
    }
    #dooms-portrait-bar-wrapper.dooms-pb-position-left .dooms-pb-scroll,
    #dooms-portrait-bar-wrapper.dooms-pb-position-right .dooms-pb-scroll,
    #dooms-portrait-bar-wrapper.dooms-pb-position-left .dooms-pb-scroll.dooms-pb-centered,
    #dooms-portrait-bar-wrapper.dooms-pb-position-right .dooms-pb-scroll.dooms-pb-centered {
        flex-direction: row !important;
        flex-wrap: nowrap !important;
        overflow-x: auto !important;
        overflow-y: hidden !important;
        align-content: normal !important;
        align-items: flex-start !important;
    }
    #dooms-portrait-bar-wrapper.dooms-pb-collapsed-side.dooms-pb-position-left {
        right: auto !important;
        border-radius: 15px !important;
    }
    #dooms-portrait-bar-wrapper.dooms-pb-collapsed-side.dooms-pb-position-right {
        left: auto !important;
        border-radius: 15px !important;
    }
    #dooms-portrait-bar-wrapper:not(.dooms-pb-position-left):not(.dooms-pb-position-right)
        .dooms-portrait-bar.dooms-pb-expanded {
        max-height: min(40vh, 300px) !important;
    }
}
`;

export function ckButtonRule(env: RuleEnv): RuleDefinition {
    return {
        id: CK_BUTTON_RULE_ID,
        titleKey: 'm22.rule.ui.ckVectorizeButton.title',
        descriptionKey: 'm22.rule.ui.ckVectorizeButton.description',
        owner: 'maestro',
        stage: 1,
        kind: 'ui',
        defaultLevel: 'auto',
        enabledByDefault: true,
        requires: ['ck.present'],
        start(): Unsubscribe {
            return env.app.ui.style('m22-ck-vectorize-button', CK_BUTTON_CSS);
        },
    };
}

export function desPortraitBarRule(env: RuleEnv): RuleDefinition {
    return {
        id: DES_BAR_RULE_ID,
        titleKey: 'm22.rule.ui.desPortraitBarMobile.title',
        descriptionKey: 'm22.rule.ui.desPortraitBarMobile.description',
        owner: 'maestro',
        stage: 1,
        kind: 'ui',
        defaultLevel: 'auto',
        enabledByDefault: true,
        requires: ['des.present'],
        start(): Unsubscribe {
            const offStyle = env.app.ui.style('m22-des-portrait-bar', DES_PORTRAIT_BAR_CSS);
            const stopCollapse = collapsePortraitBarOnce(env.log);
            return () => {
                stopCollapse();
                offStyle();
            };
        },
    };
}

/** DES toggles collapsed once (per toggle element, i.e. per page load unless DES rebuilds its bar). */
const collapsedToggles = new WeakSet<Element>();

function isNarrowScreen(): boolean {
    try {
        return globalThis.matchMedia?.(MOBILE_QUERY).matches ?? false;
    } catch {
        return false;
    }
}

export interface CollapseOptions {
    isNarrow?: () => boolean;
    intervalMs?: number;
    attempts?: number;
}

/**
 * On a narrow screen, collapses DES's portrait bar by clicking DES's own toggle (`#dooms-pb-toggle`), so DES's
 * `isExpanded` and classes stay right — only when it is expanded, and only once. DES builds the bar during its init,
 * which may come after Maestro's, so the toggle is looked for a while. Returns the stop function.
 */
export function collapsePortraitBarOnce(log: Logger, options: CollapseOptions = {}): () => void {
    if (typeof document === 'undefined' || !(options.isNarrow ?? isNarrowScreen)()) return () => {};
    const attempt = (): boolean => {
        const toggle = document.getElementById('dooms-pb-toggle');
        if (!toggle) return false;
        if (collapsedToggles.has(toggle)) return true;
        collapsedToggles.add(toggle);
        if (toggle.classList.contains('dooms-pb-open')) {
            toggle.click();
            log.debug('DES portrait bar collapsed for the phone layout');
        }
        return true;
    };
    if (attempt()) return () => {};
    const attempts = options.attempts ?? 60;
    let tries = 0;
    let timer: ReturnType<typeof setInterval> | null = setInterval(() => {
        tries += 1;
        if (attempt() || tries >= attempts) stop();
    }, options.intervalMs ?? 1000);
    function stop(): void {
        if (timer !== null) clearInterval(timer);
        timer = null;
    }
    return stop;
}
