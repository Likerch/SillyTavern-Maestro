import type { I18nParts } from '../../shared/contracts';

/** Strings of M42 «Мастерская» (`m42.*`, plus its journal kinds and targets). */
export const WORKSHOP_STRINGS: I18nParts = {
    en: {
        'm42.title': 'Workshop',
        'm42.notice.on':
            'Workshop chat: trackers, lorebooks, memory, pictures and Maestro’s story modules are silent here; the preset is «{preset}».',
        'm42.notice.onNoPreset':
            'Workshop chat: trackers, lorebooks, memory, pictures and Maestro’s story modules are silent here.',
        'm42.button.off':
            'Workshop: make this card a helper (trackers, lore and story modules stay silent in its chats)',
        'm42.button.on':
            'Workshop card: its chats run without trackers, lore and story modules. Click to make it a story card again',
        'm42.option.on': 'Workshop: make it a helper',
        'm42.option.off': 'Workshop: make it a story card again',
        'm42.noCard': 'Open the card of one character in the editor first.',
        'm42.tag.added': 'The card is a workshop card now: its chats run without the story machinery.',
        'm42.tag.removed': 'The card is a story card again.',
        'm42.tag.addFailed': 'The workshop tag was not set: SillyTavern did not take it.',
        'm42.tag.removeFailed': 'The workshop tag was not removed: SillyTavern did not take it.',
        'm42.qvink.global':
            'Qvink keeps one switch for all chats («Use global toggle state»): I did not switch it off for the workshop chat. Its memories do not reach the workshop prompt anyway.',
        'm42.qvink.back': 'Qvink is on again in this chat: its card is not a workshop card any more.',
        'm42.journal.on': '«{name}» became a workshop card',
        'm42.journal.off': '«{name}» became a story card again',
        'm42.journal.qvinkOff': 'Qvink switched off in the workshop chat',
        'm42.settings.title': 'Workshop',
        'm42.settings.hint':
            'A card with a workshop tag is a helper — a scenario or character creator, an editor. In its chats trackers (DES), pictures, CarrotKernel, Dramatis, Qvink memory, global lorebooks and Maestro’s story modules stay silent; the card, the chat, the Author’s Note and the chosen preset remain. The wrench button in the card editor sets the tag.',
        'm42.settings.tags': 'Tags of workshop cards',
        'm42.settings.tags.hint':
            'One per line or separated by commas; case does not matter. The button sets the first one.',
        'm42.settings.preset': 'Preset of workshop chats',
        'm42.settings.preset.hint':
            'Switched on when a workshop chat opens; the previous one comes back when you leave. The model stays the same. Empty: the preset is not switched.',
        'm42.settings.lore': 'Lorebooks in workshop chats',
        'm42.settings.lore.own': 'Only the card’s and the chat’s own',
        'm42.settings.lore.none': 'None',
        'm42.settings.lore.all': 'All, as in other chats',
        'm42.settings.qvink': 'Switch Qvink off in workshop chats',
        'm42.settings.qvink.hint':
            'Qvink’s own switch of the chat: no summaries, and old messages are not dropped from the prompt. It comes back on when the card leaves the workshop.',
        'm42.settings.notice': 'Say so when a workshop chat opens',
        'm42.settings.state.on': 'The chat open now is a workshop chat.',
        'm42.settings.state.off': 'The chat open now is a story chat.',
        'm42.slash.help':
            'Workshop: makes the card of the open chat a helper (on), a story card again (off), or switches it (no argument).',
        'm42.slash.value': 'on, off, or nothing to switch',
        'm42.slash.noCard': 'Open a one-on-one chat first.',
        'kind.workshop.card': 'Workshop card',
        'kind.workshop.qvink': 'Qvink in a workshop chat',
        'target.workshop-card': 'Workshop card',
        'target.workshop-qvink': 'Qvink in the chat',
        'm42.target.on': 'yes',
        'm42.target.off': 'no',
    },
    ru: {
        'm42.title': 'Мастерская',
        'm42.notice.on':
            'Чат мастерской: трекеры, лорбуки, память, картинки и сюжетные модули Maestro здесь молчат, пресет — «{preset}».',
        'm42.notice.onNoPreset':
            'Чат мастерской: трекеры, лорбуки, память, картинки и сюжетные модули Maestro здесь молчат.',
        'm42.button.off':
            'Мастерская: сделать карточку служебной (в её чатах молчат трекеры, лорбуки и сюжетные модули)',
        'm42.button.on':
            'Карточка мастерской: её чаты идут без трекеров, лорбуков и сюжетных модулей. Нажми, чтобы вернуть её в сюжетные',
        'm42.option.on': 'Мастерская: сделать служебной',
        'm42.option.off': 'Мастерская: вернуть в сюжетные',
        'm42.noCard': 'Сначала открой в редакторе карточку одного персонажа.',
        'm42.tag.added': 'Карточка теперь в мастерской: её чаты идут без сюжетной машинерии.',
        'm42.tag.removed': 'Карточка снова сюжетная.',
        'm42.tag.addFailed': 'Тег мастерской не поставился: SillyTavern его не принял.',
        'm42.tag.removeFailed': 'Тег мастерской не снялся: SillyTavern его не принял.',
        'm42.qvink.global':
            'У Qvink один переключатель на все чаты («Use global toggle state»), поэтому в чате мастерской я его не выключал. Его пересказы в промпт мастерской всё равно не попадают.',
        'm42.qvink.back': 'Qvink снова включён в этом чате: карточка больше не в мастерской.',
        'm42.journal.on': '«{name}» — теперь карточка мастерской',
        'm42.journal.off': '«{name}» — снова сюжетная карточка',
        'm42.journal.qvinkOff': 'Выключил Qvink в чате мастерской',
        'm42.settings.title': 'Мастерская',
        'm42.settings.hint':
            'Карточка с тегом мастерской — служебная: генератор сценариев или персонажей, редактор. В её чатах молчат трекеры (DES), картинки, CarrotKernel, Dramatis, память Qvink, глобальные лорбуки и сюжетные модули Maestro; остаются карточка, чат, заметка автора и выбранный пресет. Тег ставит кнопка с гаечным ключом в редакторе карточки.',
        'm42.settings.tags': 'Теги карточек мастерской',
        'm42.settings.tags.hint': 'По одному в строке или через запятую, регистр не важен. Кнопка ставит первый.',
        'm42.settings.preset': 'Пресет чатов мастерской',
        'm42.settings.preset.hint':
            'Включается, когда открываешь чат мастерской; при выходе возвращается прежний. Модель не меняется. Пусто — пресет не переключается.',
        'm42.settings.lore': 'Лорбуки в чатах мастерской',
        'm42.settings.lore.own': 'Только свои: карточки и чата',
        'm42.settings.lore.none': 'Никаких',
        'm42.settings.lore.all': 'Все, как в других чатах',
        'm42.settings.qvink': 'Выключать Qvink в чатах мастерской',
        'm42.settings.qvink.hint':
            'Собственный переключатель Qvink для чата: без пересказов, и старые сообщения не выпадают из промпта. Включается обратно, когда карточка уходит из мастерской.',
        'm42.settings.notice': 'Сообщать, когда открывается чат мастерской',
        'm42.settings.state.on': 'Открытый сейчас чат — чат мастерской.',
        'm42.settings.state.off': 'Открытый сейчас чат — сюжетный.',
        'm42.slash.help':
            'Мастерская: делает карточку открытого чата служебной (on), снова сюжетной (off) или переключает (без аргумента).',
        'm42.slash.value': 'on, off или ничего — переключить',
        'm42.slash.noCard': 'Сначала открой чат с одним персонажем.',
        'kind.workshop.card': 'Карточка мастерской',
        'kind.workshop.qvink': 'Qvink в чате мастерской',
        'target.workshop-card': 'Карточка мастерской',
        'target.workshop-qvink': 'Qvink в чате',
        'm42.target.on': 'да',
        'm42.target.off': 'нет',
    },
};
