// M32 part «st»: SillyTavern itself in Maestro's shape language — top bar and drawer icons, drawers and settings
// panels (inline drawers, the extensions column), popups and menus, buttons, inputs, checkboxes, scrollbars, toasts,
// the start page (recent chats, welcome messages), «Manage chat files», persona management, the character list and
// the Top Info Bar extension's chat bar. Colours, blur and shadows stay ST's (through the tokens). The send form
// belongs to the «chat» part (css-chat.ts); the clean last-message previews of the chat lists are previews.ts.
//
// How it stays safe:
// - every rule is gated by `:where(html.maestro-theme.maestro-theme-st)`: remove the class and nothing applies;
// - `:where()` adds no specificity, so each rule mirrors ST's own selector exactly, ties with it and wins only by
//   source order; ST's more specific modifiers (toggled buttons, the red OK button, the API button) keep working,
//   and the user's custom CSS (moved after Maestro's sheets by the layer) still wins over ours;
// - the Top Info Bar extension loads its sheet after Maestro's, so its rules are outranked by one more id (`#sheld`,
//   `#movingDivs`) instead of source order;
// - only visual properties change (radius, border colour, background, shadow, focus ring, type; padding only at the
//   compact density); never display, position, width or margins. The one size change is ST's own: the comfortable
//   density gives the top bar air through ST's variable --topBarBlockPadding, so everything ST derives from
//   --topBarBlockSize (#sheld, drawers, popups, toasts) follows; ST's value stays at the compact density and on iOS,
//   whose #sheld height is a fixed `100dvh - 36px`;
// - Maestro's own buttons (`.maestro-btn`) keep their colours and their 44px phone size (src/ui/style.css).
import type { Density } from '../../domain/theme-tokens';
import { THEME_CLASS, partClass } from './api';

/** Gate of every rule of this part. */
export const ST_GATE = `:where(html.${THEME_CLASS}.${partClass('st')})`;
const G = ST_GATE;
const T = 'var(--animation-duration, 125ms)';

/** ST's top bar padding at the comfortable density (ST: `calc(var(--mainFontSize) / 3)`). */
export const TOP_BAR_PADDING = 'calc(var(--mainFontSize) / 1.6)';

const COMFORTABLE = `
/* ---------------------------------------------------------------- comfortable density: a top bar with air */
@supports not (-webkit-touch-callout: none) {
    ${G}:root {
        --topBarBlockPadding: ${TOP_BAR_PADDING};
    }

    /* ST sizes the bar's backdrop by the send form's block size: it follows the taller icon row instead. */
    ${G} #top-bar {
        --bottomFormBlockSize: var(--topBarBlockSize);
    }
}
`;

const COMPACT = `
/* ---------------------------------------------------------------- compact density */
${G} .menu_button {
    padding: var(--maestro-control-py) var(--maestro-control-px);
}

${G} .text_pole {
    padding: var(--maestro-control-py) var(--maestro-control-px);
}
`;

const BASE = `
/* ---------------------------------------------------------------- page */
${G} {
    accent-color: var(--maestro-accent);
}

${G} ::selection {
    background-color: var(--maestro-accent-soft);
}

/* ---------------------------------------------------------------- scrollbars */
${G} ::-webkit-scrollbar-thumb:vertical,
${G} ::-webkit-scrollbar-thumb:horizontal {
    background-color: var(--maestro-scroll-thumb);
    box-shadow: none;
    border-radius: var(--maestro-radius-pill);
}

${G} ::-webkit-scrollbar-thumb:hover {
    background-color: var(--maestro-text-muted);
}

@supports not selector(::-webkit-scrollbar) {
    ${G} {
        scrollbar-color: var(--maestro-scroll-thumb) transparent;
    }
}

/* ---------------------------------------------------------------- top bar and drawer icons */
${G} #top-bar {
    box-shadow: var(--maestro-elevation-2);
    border-bottom: 1px solid var(--maestro-divider);
}

${G} .drawer-icon {
    border-radius: var(--maestro-radius-sm);
    transition:
        opacity ${T},
        color ${T},
        background-color ${T};
}

${G} .drawer-icon.closedIcon {
    opacity: 0.45;
}

${G} .drawer-icon.closedIcon:hover {
    opacity: 1;
    background-color: var(--maestro-surface-3);
}

${G} .drawer-icon.openIcon {
    color: var(--maestro-accent);
}

${G} .drawer-toggle:focus-visible,
${G} .drawer-icon:focus-visible {
    outline: 2px solid var(--maestro-focus);
    outline-offset: 1px;
}

/* ---------------------------------------------------------------- drawers and settings panels */
${G} .drawer-content {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-lg);
    box-shadow: var(--maestro-elevation-2);
}

${G} .inline-drawer-header {
    border-radius: var(--maestro-radius-sm);
    transition: background-color ${T};
}

${G} .inline-drawer-toggle.inline-drawer-header:hover {
    background-color: var(--maestro-surface-2);
}

${G} .inline-drawer-icon {
    transition:
        filter ${T},
        transform ${T};
}

${G} .inline-drawer-header:hover .inline-drawer-icon {
    filter: brightness(110%);
}

${G} #extensions_settings .inline-drawer-toggle.inline-drawer-header,
${G} #extensions_settings2 .inline-drawer-toggle.inline-drawer-header,
${G} #user-settings-block h4,
${G} .standoutHeader {
    background-image: none;
    background-color: var(--maestro-surface-2);
    border: 1px solid var(--maestro-divider);
    border-radius: var(--maestro-radius-md);
    box-shadow: inset 3px 0 0 var(--maestro-accent);
}

${G} #extensions_settings .inline-drawer-toggle.inline-drawer-header:hover,
${G} #extensions_settings2 .inline-drawer-toggle.inline-drawer-header:hover,
${G} .standoutHeader.inline-drawer-header:hover {
    filter: none;
    background-color: var(--maestro-surface-3);
}

${G} .standoutHeader~.inline-drawer-content {
    border-color: var(--maestro-divider);
    border-radius: var(--maestro-radius-md);
    background-color: var(--maestro-well);
}

${G} .settingsSectionWrap {
    border-color: var(--maestro-divider);
    border-radius: var(--maestro-radius-md);
}

/* ---------------------------------------------------------------- popups and menus */
/* Same specificity as ST's .popup: Maestro's full-screen phone dialogs (.popup.maestro-*-dialog, radius 0) still win. */
${G} .popup {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-lg);
    box-shadow: var(--maestro-elevation-2);
}

${G} .popup .popup-button-close {
    border-radius: var(--maestro-radius-pill);
}

${G} #options,
${G} #extensionsMenu,
${G} .popup .popper-modal {
    border-radius: var(--maestro-radius-lg);
    box-shadow: var(--maestro-elevation-2);
}

${G} .options-content,
${G} .list-group {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-md);
}

${G} .options-content a,
${G} #extensionsMenu>.extension_container>div,
${G} #extensionsMenu>div:not(.extension_container),
${G} .list-group>div,
${G} .list-group .list-group-item {
    border-radius: var(--maestro-radius-sm);
    transition:
        opacity ${T},
        background-color ${T};
}

${G} #extensionsMenu>.extension_container>div:hover,
${G} #extensionsMenu>div:not(.extension_container):hover,
${G} .options-content a:hover,
${G} .list-group-item:hover {
    background-color: var(--maestro-surface-3);
}

/* ---------------------------------------------------------------- buttons */
${G} .menu_button {
    border-radius: var(--maestro-radius-sm);
    transition:
        background-color ${T},
        border-color ${T},
        box-shadow ${T},
        filter ${T};
}

${G} .menu_button:where(:not(.maestro-btn)) {
    border-color: var(--maestro-border);
}

${G} .menu_button:not(.disabled):not([disabled]):hover,
${G} .menu_button:not(.disabled):not([disabled]).active {
    background-color: var(--maestro-surface-3);
}

${G} .menu_button:focus-visible {
    outline: 2px solid var(--maestro-focus);
    outline-offset: 1px;
}

/* ---------------------------------------------------------------- inputs */
${G} .text_pole {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-sm);
    background-color: var(--maestro-well);
    transition:
        border-color ${T},
        box-shadow ${T};
}

${G} select {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-sm);
}

${G} textarea {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-sm);
}

${G} select:focus-visible,
${G} input:focus-visible,
${G} textarea:focus-visible {
    outline: 2px solid var(--maestro-accent-soft);
    outline-offset: 0;
    border-color: var(--maestro-accent);
}

${G} input[type='checkbox'] {
    border-radius: var(--maestro-radius-xs);
    transition:
        box-shadow ${T},
        outline-color ${T};
}

${G} input[type='checkbox']:focus-visible {
    outline: 2px solid var(--maestro-focus);
    outline-offset: 1px;
}

/* ---------------------------------------------------------------- character and persona lists */
${G} .bogus_folder_select,
${G} .character_select,
${G} .group_select,
${G} .avatar-container {
    border-radius: var(--maestro-radius-md);
    transition:
        background-color ${T},
        border-color ${T};
}

${G} .bogus_folder_select:hover,
${G} .character_select:hover,
${G} .group_select:hover,
${G} .avatar-container:hover {
    background-color: var(--maestro-surface-3);
}

${G} .ch_description {
    color: var(--maestro-text-muted);
}

${G} .avatar-container .ch_additional_info,
${G} .character_name_block .character_version {
    color: var(--maestro-text-muted);
    font-variant-numeric: tabular-nums;
}

/* ---------------------------------------------------------------- persona management (#PersonaManagement) */
/* The chosen persona: ST's white frame becomes the accent; the default persona keeps ST's golden avatar ring. */
${G} .avatar-container.selected {
    border-color: var(--maestro-accent);
    background-color: var(--maestro-accent-soft);
}

${G} #user_avatar_block .avatar_upload {
    background-color: var(--maestro-surface-2);
    border: 1px dashed var(--maestro-border);
    transition:
        background-color ${T},
        border-color ${T};
}

${G} #user_avatar_block .avatar_upload:hover {
    background-color: var(--maestro-surface-3);
    border-color: var(--maestro-accent);
}

/* «Chat» / «Character» lock badges on the cards. */
${G} #persona-management-block .avatar_container_states .menu_button {
    border-color: var(--maestro-divider);
    border-radius: var(--maestro-radius-pill);
    background-color: var(--maestro-surface-2);
    font-size: calc(var(--mainFontSize) * 0.85);
}

${G} #persona_controls .persona_name {
    opacity: 0.9;
    font-weight: 600;
    letter-spacing: 0.01em;
}

${G} #persona_description {
    line-height: 1.5;
}

/* Connections: Default / Character / Chat; ST colours the locked icons (gold, green, quote colour). */
${G} #persona_connections_buttons .menu_button.locked {
    background-color: var(--maestro-surface-2);
    box-shadow: inset 0 0 0 1px var(--maestro-divider);
}

${G} #persona_connections_buttons .menu_button.locked:hover {
    background-color: var(--maestro-surface-3);
}

${G} #lock_persona_default.locked {
    border-color: color-mix(in srgb, var(--golden, gold) 50%, var(--maestro-border));
}

/* ---------------------------------------------------------------- start page: recent chats (welcome-screen.js) */
${G} .welcomePanel {
    border: 1px solid var(--maestro-divider);
    border-radius: var(--maestro-radius-lg);
    background-color: var(--maestro-surface-2);
    box-shadow: var(--maestro-elevation-1);
}

/* Bubbles: ST's bot-bubble tint stays the background. */
${G} body.bubblechat .welcomePanel {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-lg);
}

${G} .welcomePanel .welcomeHeaderVersionDisplay {
    font-family: var(--maestro-font-ui);
    letter-spacing: 0.01em;
}

${G} .welcomePanel .recentChatsTitle {
    font-family: var(--maestro-font-ui);
    letter-spacing: 0.02em;
}

${G} .welcomePanel .welcomeShortcuts .menu_button {
    border-color: var(--maestro-divider);
    border-radius: var(--maestro-radius-pill);
    background-color: var(--maestro-surface-2);
}

${G} .welcomePanel .welcomeShortcuts .menu_button:hover {
    border-color: var(--maestro-border);
    background-color: var(--maestro-surface-3);
}

${G} .welcomePanel .welcomeShortcuts .welcomeShortcutsSeparator {
    color: var(--maestro-divider);
}

${G} .welcomePanel .recentChatList .noRecentChat {
    color: var(--maestro-text-muted);
}

${G} .welcomeRecent .recentChatList .recentChat {
    border-color: var(--maestro-divider);
    border-radius: var(--maestro-radius-md);
    background-color: var(--maestro-surface-2);
    transition:
        background-color ${T},
        border-color ${T},
        box-shadow ${T};
}

${G} .welcomeRecent .recentChatList .recentChat:hover {
    border-color: var(--maestro-border);
    background-color: var(--maestro-surface-3);
}

${G} .welcomeRecent .recentChatList .recentChat:focus-visible {
    outline: 2px solid var(--maestro-focus);
    outline-offset: 1px;
}

/* Pinned chats: an accent edge, the pin in the accent colour. */
${G} .welcomeRecent .recentChatList .recentChat:has(.recentChatPinned) {
    border-color: color-mix(in srgb, var(--maestro-accent) 45%, transparent);
    box-shadow: inset 3px 0 0 var(--maestro-accent);
}

${G} .welcomeRecent .recentChatList .recentChat .recentChatPinned {
    color: var(--maestro-accent);
    opacity: 1;
}

${G} .welcomeRecent .recentChatList .recentChat .avatar img {
    border-color: var(--maestro-border);
    box-shadow: var(--maestro-elevation-1);
}

${G} .welcomeRecent .recentChatList .recentChat .chatNameContainer .chatName {
    color: var(--maestro-text-muted);
}

${G} .welcomeRecent .recentChatList .recentChat .chatNameContainer .chatName .characterName {
    color: var(--maestro-text);
    font-weight: 600;
    letter-spacing: 0.01em;
}

${G} .welcomeRecent .recentChatList .recentChat .chatNameContainer .chatDate,
${G} .welcomeRecent .recentChatList .recentChat .chatStats {
    color: var(--maestro-text-muted);
    font-variant-numeric: tabular-nums;
}

${G} .welcomeRecent .recentChatList .recentChat .chatMessageContainer .chatMessage {
    color: var(--maestro-text);
    opacity: 0.85;
    line-height: 1.4;
}

${G} .welcomeRecent .recentChatList .recentChat .chatStats .counterBlock::after {
    color: var(--maestro-divider);
}

${G} .welcomeRecent .recentChatList .recentChat .chatActions button {
    transition:
        opacity ${T},
        background-color ${T},
        border-color ${T};
}

${G} .welcomeRecent .recentChatList .recentChat .chatActions .pinChat.active {
    color: var(--maestro-accent);
    border-color: color-mix(in srgb, var(--maestro-accent) 60%, transparent);
}

/* ST rotates the chevron when the list is open: keep that animated. */
${G} .welcomeRecent .recentChatList .showMoreChats {
    border-radius: var(--maestro-radius-pill);
    transition:
        transform ${T},
        background-color ${T};
}

/* Mouse only: the card's actions come up on hover (touch screens always show them). */
@media (hover: hover) {
    ${G} .welcomeRecent .recentChatList .recentChat .chatActions button {
        opacity: 0.55;
    }

    ${G} .welcomeRecent .recentChatList .recentChat:hover .chatActions button,
    ${G} .welcomeRecent .recentChatList .recentChat .chatActions button:focus-visible,
    ${G} .welcomeRecent .recentChatList .recentChat .chatActions .pinChat.active {
        opacity: 1;
    }
}

/* ---------------------------------------------------------------- start page: welcome messages */
/* The assistant's greeting (type assistant_message): a raised card with an accent edge (bubbles keep ST's look). */
${G} body:not(.bubblechat) #chat .mes[type="assistant_message"]:not(.selected) {
    background-color: var(--maestro-surface-2);
    box-shadow: inset 3px 0 0 color-mix(in srgb, var(--maestro-accent) 55%, transparent);
}

/* «API Connections» / «Character Management» / «Extensions» (welcome_prompt). */
${G} #chat .mes[type="welcome_prompt"] .drawer-opener {
    border-color: var(--maestro-divider);
    border-radius: var(--maestro-radius-pill);
    background-color: var(--maestro-surface-2);
    transition:
        background-color ${T},
        border-color ${T};
}

${G} #chat .mes[type="welcome_prompt"] .drawer-opener:hover {
    border-color: color-mix(in srgb, var(--maestro-accent) 60%, transparent);
    background-color: var(--maestro-accent-soft);
}

${G} #chat .mes[type="welcome_prompt"] .drawer-opener i {
    color: var(--maestro-accent);
}

/* ---------------------------------------------------------------- «Manage chat files» (#select_chat_popup) */
${G} #select_chat_popup {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-lg);
    box-shadow: var(--maestro-elevation-2);
}

${G} #select_chat_search {
    border-radius: var(--maestro-radius-pill);
}

${G} #select_chat_cross {
    border-radius: var(--maestro-radius-pill);
    transition: opacity ${T};
}

${G} .select_chat_block {
    border-color: var(--maestro-divider);
    border-radius: var(--maestro-radius-md);
    background-color: var(--maestro-surface-2);
    transition:
        background-color ${T},
        border-color ${T};
}

${G} .select_chat_block:hover {
    border-color: var(--maestro-border);
    background-color: var(--maestro-surface-3);
}

/* The open chat. */
${G} .select_chat_block[highlight] {
    border-color: color-mix(in srgb, var(--maestro-accent) 50%, transparent);
    background-color: var(--maestro-accent-soft);
    box-shadow: inset 3px 0 0 var(--maestro-accent);
}

${G} .select_chat_block_filename.select_chat_block_filename_item {
    opacity: 1;
    font-weight: 600;
    letter-spacing: 0.01em;
}

${G} .select_chat_info .select_chat_block_filename_item {
    opacity: 1;
    color: var(--maestro-text-muted);
    font-variant-numeric: tabular-nums;
}

${G} .select_chat_block_mes {
    opacity: 0.85;
    line-height: 1.4;
}

${G} .select_chat_actions>div,
${G} .renameChatButton {
    border-radius: var(--maestro-radius-xs);
    transition: opacity ${T};
}

/* ---------------------------------------------------------------- Top Info Bar (the chat bar over the chat) */
/* Extension-TopInfoBar: #extensionTopBar (chat select, search, icons) in #sheld, #extensionConnectionProfiles under
   it, the chat side bar #extensionSideBar in #movingDivs. One more id outranks its sheet, loaded after Maestro's. */
${G} #sheld #extensionTopBar {
    border-color: var(--maestro-border);
    border-radius: var(--maestro-radius-lg) var(--maestro-radius-lg) 0 0;
    box-shadow: var(--maestro-elevation-1);
}

${G} #sheld #extensionConnectionProfiles {
    border-color: var(--maestro-border);
    border-radius: 0 0 var(--maestro-radius-lg) var(--maestro-radius-lg);
}

${G} #sheld #extensionTopBar .right_menu_button {
    border-radius: var(--maestro-radius-sm);
    transition:
        filter ${T},
        color ${T},
        background-color ${T};
}

${G} #sheld #extensionTopBar .right_menu_button:hover {
    background-color: var(--maestro-surface-3);
}

${G} #sheld #extensionTopBar .right_menu_button.active {
    color: var(--maestro-accent);
}

${G} #sheld #extensionTopBar .right_menu_button:focus-visible {
    outline: 2px solid var(--maestro-focus);
    outline-offset: 1px;
}

${G} #sheld #extensionTopBarChatName {
    border-radius: var(--maestro-radius-sm);
    font-weight: 600;
    opacity: 1;
    transition: background-color ${T};
}

${G} #sheld #extensionTopBarChatName:hover {
    background-color: var(--maestro-surface-2);
}

${G} #sheld #extensionTopBarSearchInput {
    border-radius: var(--maestro-radius-pill);
    background-color: var(--maestro-well);
}

${G} #movingDivs #extensionSideBar #extensionSideBarContainer .sideBarItem {
    border-color: var(--maestro-divider);
    border-radius: var(--maestro-radius-md);
    background-color: var(--maestro-surface-2);
    transition:
        background-color ${T},
        border-color ${T};
}

${G} #movingDivs #extensionSideBar #extensionSideBarContainer .sideBarItem:hover {
    border-color: var(--maestro-border);
    background-color: var(--maestro-surface-3);
}

${G} #movingDivs #extensionSideBar #extensionSideBarContainer .sideBarItem.selected {
    border-color: color-mix(in srgb, var(--maestro-accent) 50%, transparent);
    background-color: var(--maestro-accent-soft);
    box-shadow: inset 3px 0 0 var(--maestro-accent);
}

${G} #movingDivs #extensionSideBar #extensionSideBarContainer .sideBarItem .chatName {
    font-weight: 600;
}

${G} #movingDivs #extensionSideBar #extensionSideBarContainer .sideBarItem .chatDate,
${G} #movingDivs #extensionSideBar #extensionSideBarContainer .sideBarItem .chatStats {
    color: var(--maestro-text-muted);
    font-variant-numeric: tabular-nums;
}

${G} #movingDivs #extensionSideBar #extensionSideBarContainer .sideBarItem .chatMessage {
    opacity: 0.85;
}

/* ---------------------------------------------------------------- toasts */
${G} body #toast-container>div {
    border-radius: var(--maestro-radius-md);
    box-shadow: var(--maestro-elevation-2);
}

/* ---------------------------------------------------------------- phones (ST's breakpoint) */
@media screen and (max-width: 1000px) {
    ${G} .menu_button:where(:not(.maestro-btn)) {
        min-height: var(--maestro-touch);
    }

    ${G} .menu_button:where(.fa-solid, .fa-regular, .fa-fw):where(:not(.maestro-btn)) {
        min-width: var(--maestro-touch);
    }

    ${G} .text_pole,
    ${G} select {
        min-height: var(--maestro-touch);
    }

    ${G} input[type='checkbox'] {
        width: calc(var(--mainFontSize) * 1.3);
        height: calc(var(--mainFontSize) * 1.3);
    }

    ${G} .inline-drawer-header {
        min-height: var(--maestro-touch);
    }

    ${G} .options-content a,
    ${G} #extensionsMenu>.extension_container>div,
    ${G} #extensionsMenu>div:not(.extension_container),
    ${G} .list-group .list-group-item {
        padding-top: var(--maestro-space-2);
        padding-bottom: var(--maestro-space-2);
    }

    ${G} #right-nav-panel,
    ${G} #left-nav-panel {
        border-radius: 0 0 var(--maestro-radius-lg) var(--maestro-radius-lg);
    }

    /* Start page: ST hides the shortcut labels on phones, the icons become square targets. */
    ${G} .welcomePanel .welcomeShortcuts .menu_button,
    ${G} .welcomeRecent .recentChatList .showMoreChats {
        min-width: var(--maestro-touch);
    }

    ${G} .welcomeRecent .recentChatList .recentChat .chatActions button {
        min-width: calc(var(--maestro-touch) * 0.8);
    }

    /* The lock badges on persona cards are labels, not targets: ST's own height. */
    ${G} #persona-management-block .avatar_container_states .menu_button {
        min-height: auto;
    }

    /* «Manage chat files»: rename, export, delete are 15px glyphs in ST. */
    ${G} .select_chat_actions>div,
    ${G} .renameChatButton {
        min-width: var(--maestro-touch);
        min-height: var(--maestro-touch);
        line-height: var(--maestro-touch);
        text-align: center;
    }
}

/* ---------------------------------------------------------------- touch screens: no sticky hovers */
@media (hover: none) {
    ${G} .drawer-icon.closedIcon:hover,
    ${G} .bogus_folder_select:hover,
    ${G} .character_select:hover,
    ${G} .group_select:hover,
    ${G} .avatar-container:hover {
        background-color: transparent;
    }
}
`;

/**
 * The «st» stylesheet. Comfortable: a taller top bar (ST's --topBarBlockPadding) and ST's own control padding;
 * compact: ST's top bar and tighter control padding.
 */
export function stCss(density: Density): string {
    return density === 'compact' ? `${BASE}${COMPACT}` : `${BASE}${COMFORTABLE}`;
}
