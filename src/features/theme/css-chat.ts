// M32 part «chat»: chat messages in one look for ST's three chat styles (flat, bubbles `body.bubblechat`, document
// `body.documentstyle`): message corners and spacing, the name line and timestamp, avatars, message actions, swipes,
// reasoning blocks, code, quotes and images. The colours stay ST's: quote/em/underline colours, the chat tint and the
// user/bot message tints (bubbles) are read from ST's variables directly, so they follow the theme live.
//
// Same safety rules as the «st» part (css-st.ts): `:where()` gate, ST's selectors mirrored at equal specificity,
// visual properties only; the message padding changes only at the compact density.
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

/* ---------------------------------------------------------------- phones */
@media screen and (max-width: 1000px) {
    ${G} .swipe_right,
    ${G} .swipe_left {
        width: 32px;
        height: 32px;
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
