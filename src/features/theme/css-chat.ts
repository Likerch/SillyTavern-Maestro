// M32 part «chat»: chat messages in one look for ST's three chat styles (flat, bubbles `body.bubblechat`, document
// `body.documentstyle`): message corners and spacing, the name line and timestamp, avatars, message actions, swipes,
// reasoning blocks, code, quotes and images; and the composer under the chat (#send_form, «окно сообщений игрока»).
// The colours stay ST's: quote/em/underline colours, the chat tint and the user/bot message tints (bubbles) are read
// from ST's variables directly, so they follow the theme live.
//
// Same safety rules as the «st» part (css-st.ts): `:where()` gate, ST's selectors mirrored at equal specificity,
// visual properties only; the message padding changes only at the compact density. The composer keeps ST's flex
// structure and sizes: only the text area's padding and line height change (they stay inside ST's block size), and
// on phones its font size (16px, so iOS does not zoom) and the icons' touch size.
import type { Density } from '../../domain/theme-tokens';
import { THEME_CLASS, partClass } from './api';

/** Gate of every rule of this part. */
export const CHAT_GATE = `:where(html.${THEME_CLASS}.${partClass('chat')})`;
const G = CHAT_GATE;
const T = 'var(--animation-duration, 125ms)';

const BASE = `
/* ---------------------------------------------------------------- messages */
${G} .mes {
    border-radius: var(--maestro-radius-md);
    transition: background-color ${T};
}

@media (hover: hover) {
    ${G} body:not(.bubblechat):not(.documentstyle) #chat .mes:not(.selected):hover {
        background-color: var(--maestro-surface-2);
    }
}

/* Bubbles: ST's user/bot tints stay the backgrounds. */
${G} body.bubblechat .mes {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-lg);
    box-shadow: var(--maestro-elevation-1);
}

/* ---------------------------------------------------------------- name line, timestamp, counters */
${G} :where(.mes) .name_text {
    font-weight: 600;
    letter-spacing: 0.01em;
}

${G} :where(.mes) .timestamp {
    color: var(--maestro-text-muted);
    opacity: 1;
    font-variant-numeric: tabular-nums;
}

${G} .mes .mes_timer,
${G} .mes .mesIDDisplay,
${G} .mes .tokenCounterDisplay {
    color: var(--maestro-text-muted);
    font-variant-numeric: tabular-nums;
}

/* ---------------------------------------------------------------- avatars (ST's avatar shape setting is kept) */
${G} :where(.mes) .avatar img {
    border-color: var(--maestro-border);
    box-shadow: var(--maestro-elevation-1);
}

/* ---------------------------------------------------------------- message actions */
${G} .mes_button,
${G} .extraMesButtons>div {
    border-radius: var(--maestro-radius-sm);
    transition:
        opacity ${T},
        background-color ${T};
}

${G} .mes_button:hover,
${G} .extraMesButtons>div:hover {
    background-color: var(--maestro-surface-3);
}

${G} .mes_edit_buttons .menu_button,
${G} .mes_reasoning_actions .menu_button {
    border-radius: var(--maestro-radius-sm);
}

/* ---------------------------------------------------------------- swipes */
${G} .swipe_right,
${G} .swipe_left {
    border-radius: var(--maestro-radius-pill);
    transition:
        opacity ${T},
        background-color ${T};
}

${G} .swipe_right:hover,
${G} .swipe_left:hover {
    background-color: var(--maestro-surface-3);
}

${G} .swipes-counter {
    font-variant-numeric: tabular-nums;
}

/* ---------------------------------------------------------------- reasoning */
${G} .mes_reasoning_header {
    background-color: var(--maestro-surface-2);
    border: 1px solid var(--maestro-divider);
    border-radius: var(--maestro-radius-md);
    transition: background-color ${T};
}

${G} .mes_reasoning_details[data-has-content="true"] .mes_reasoning_header:hover {
    background-color: var(--maestro-surface-3);
}

${G} .mes_reasoning {
    border-radius: var(--maestro-radius-xs);
}

/* ---------------------------------------------------------------- code and quotes (colours: ST's) */
/* ST styles every \`code\` (0,0,1); \`:where()\` keeps that specificity, scoped to messages. */
${G} :where(.mes_text, .mes_reasoning) code {
    border-color: var(--maestro-divider);
    border-radius: var(--maestro-radius-xs);
}

${G} .mes_text pre code,
${G} .mes_reasoning pre code {
    border-radius: var(--maestro-radius-md);
}

${G} .mes_text blockquote,
${G} .mes_reasoning blockquote {
    border-radius: 0 var(--maestro-radius-sm) var(--maestro-radius-sm) 0;
    background-color: var(--maestro-surface-2);
}

/* ---------------------------------------------------------------- images (generic: ST's media and any <img>) */
${G} .mes .mes_img_container,
${G} .mes .mes_video_container {
    border-radius: var(--maestro-radius-md);
    box-shadow: var(--maestro-elevation-1);
}

${G} .mes_text img:not(.mes_img),
${G} .mes_reasoning img:not(.mes_img) {
    border-radius: var(--maestro-radius-md);
}

/* ---------------------------------------------------------------- composer (#send_form) */
/* ST's surface (blur tint + blur) stays; a frame, a soft lift and one focus ring for the whole form. */
${G} #send_form {
    border-color: var(--maestro-border);
    border-radius: 0 0 var(--maestro-radius-lg) var(--maestro-radius-lg);
    box-shadow: var(--maestro-elevation-1);
    transition:
        border-color ${T},
        box-shadow ${T};
}

${G} #send_form:has(#send_textarea:focus-visible) {
    border-color: var(--maestro-accent);
    outline: 2px solid var(--maestro-accent-soft);
    outline-offset: 0;
}

/* ST: 6px all round, normal line height; 6px + 1.4 lines + ST's 3px progress edge fit ST's block size. */
${G} #send_textarea {
    padding: 6px var(--maestro-space-2);
    line-height: 1.4;
}

${G} #send_textarea::placeholder {
    opacity: 0.6;
}

${G} #rightSendForm>div:not(.mes_stop),
${G} #leftSendForm>div {
    border-radius: var(--maestro-radius-md);
    transition:
        opacity ${T},
        color ${T},
        background-color ${T};
}

${G} #rightSendForm>div:hover,
${G} #leftSendForm>div:hover {
    background-color: var(--maestro-surface-3);
}

${G} #rightSendForm>div:focus-visible,
${G} #leftSendForm>div:focus-visible {
    outline: 2px solid var(--maestro-focus);
    outline-offset: -2px;
}

${G} #send_but {
    color: var(--maestro-accent);
}

/* Quick Replies under the text area (its sheet loads after Maestro's: one more id). */
${G} #send_form #qr--bar>.qr--buttons .qr--button {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-pill);
    transition:
        background-color ${T},
        border-color ${T};
}

${G} #send_form #qr--bar>.qr--buttons .qr--button:hover {
    border-color: var(--maestro-accent);
    background-color: var(--maestro-surface-3);
}

/* ---------------------------------------------------------------- phones */
@media screen and (max-width: 1000px) {
    ${G} .swipe_right,
    ${G} .swipe_left {
        width: 32px;
        height: 32px;
    }

    /* 16px or more: iOS zooms into smaller inputs. */
    ${G} #send_textarea {
        font-size: max(16px, var(--mainFontSize));
    }

    ${G} #rightSendForm>div:not(.mes_stop),
    ${G} #leftSendForm>div {
        min-height: var(--maestro-touch);
    }
}

/* Wider phones and tablets: square targets (portrait phones keep ST's 1.15em icon columns). */
@media screen and (min-width: 451px) and (max-width: 1000px) {
    ${G} #rightSendForm>div:not(.mes_stop),
    ${G} #leftSendForm>div {
        min-width: var(--maestro-touch);
    }
}

/* Touch screens: no sticky hovers on the composer's icons. */
@media (hover: none) {
    ${G} #rightSendForm>div:hover,
    ${G} #leftSendForm>div:hover {
        background-color: transparent;
    }
}
`;

const COMPACT = `
/* ---------------------------------------------------------------- compact density */
${G} .mes {
    padding: var(--maestro-mes-pad) var(--maestro-mes-pad) 0 var(--maestro-mes-pad);
}

${G} body.bubblechat .mes {
    padding: var(--maestro-mes-pad);
    margin-bottom: var(--maestro-space-1);
}
`;

/** The «chat» stylesheet; the compact density adds tighter message padding (comfortable keeps ST's own). */
export function chatCss(density: Density): string {
    return density === 'compact' ? `${BASE}${COMPACT}` : BASE;
}
