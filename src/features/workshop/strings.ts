import type { I18nParts } from '../../shared/contracts';

/** Strings of M42 «Служебный режим» (ex-«Мастерская»; `m42.*`, plus its journal kinds and targets). */
export const WORKSHOP_STRINGS: I18nParts = {
    en: {
        'm42.title': 'Service mode',
        'm42.notice.on':
            'Service chat: trackers, lorebooks, memory, pictures and Maestro’s story modules are silent here; the preset is «{preset}».',
        'm42.notice.onNoPreset':
            'Service chat: trackers, lorebooks, memory, pictures and Maestro’s story modules are silent here.',
        'm42.button.off':
            'Service mode: make this card a service card (trackers, lore and story modules stay silent in its chats)',
        'm42.button.on':
            'Service card: its chats run without trackers, lore and story modules. Click to make it a story card again',
        'm42.option.on': 'Service mode: switch on for this card',
        'm42.option.off': 'Service mode: make it a story card again',
        'm42.noCard': 'Open the card of one character in the editor first.',
        'm42.tag.added': 'The card is a service card now: its chats run without the story machinery.',
        'm42.tag.removed': 'The card is a story card again.',
        'm42.tag.addFailed': 'The service tag was not set: SillyTavern did not take it.',
        'm42.tag.removeFailed': 'The service tag was not removed: SillyTavern did not take it.',
        'm42.qvink.global':
            'Qvink keeps one switch for all chats («Use global toggle state»): I did not switch it off for the service chat. Its memories do not reach the prompt of a service chat anyway.',
        'm42.qvink.back': 'Qvink is on again in this chat: its card is not a service card any more.',
        'm42.journal.on': '«{name}» became a service card',
        'm42.journal.off': '«{name}» became a story card again',
        'm42.journal.qvinkOff': 'Qvink switched off in the service chat',
        'm42.settings.title': 'Service mode',
        'm42.settings.hint':
            'A card with a service tag is a helper — a scenario or character creator, an editor, a co-author. In its chats trackers (DES), pictures, CarrotKernel, Dramatis, Qvink memory, global lorebooks and Maestro’s story modules stay silent; the card, the chat, the Author’s Note and the chosen preset remain. The wrench button in the card editor sets the tag. This mode used to be called «Workshop».',
        'm42.settings.tags': 'Tags of service cards',
        'm42.settings.tags.hint':
            'One per line or separated by commas; case does not matter. The button sets the first one; a card with any of them is a service card.',
        'm42.settings.preset': 'Preset of service chats',
        'm42.settings.preset.hint':
            'Switched on when a service chat opens; the previous one comes back when you leave. The model stays the same. Empty: the preset is not switched.',
        'm42.settings.lore': 'Lorebooks in service chats',
        'm42.settings.lore.own': 'Only the card’s and the chat’s own',
        'm42.settings.lore.none': 'None',
        'm42.settings.lore.all': 'All, as in other chats',
        'm42.settings.qvink': 'Switch Qvink off in service chats',
        'm42.settings.qvink.hint':
            'Qvink’s own switch of the chat: no summaries, and old messages are not dropped from the prompt. It comes back on when the card stops being a service card.',
        'm42.settings.notice': 'Say so when a service chat opens',
        'm42.settings.state.on': 'The chat open now is a service chat.',
        'm42.settings.state.off': 'The chat open now is a story chat.',
        'm42.slash.help':
            'Service mode: makes the card of the open chat a service card (on), a story card again (off), or switches it (no argument).',
        'm42.slash.value': 'on, off, or nothing to switch',
        'm42.slash.noCard': 'Open a one-on-one chat first.',
        'kind.workshop.card': 'Service card',
        'kind.workshop.qvink': 'Qvink in a service chat',
        'target.workshop-card': 'Service card',
        'target.workshop-qvink': 'Qvink in the chat',
        'm42.target.on': 'yes',
        'm42.target.off': 'no',
    },
    ru: {
        'm42.title': 'Служебный режим',
        'm42.notice.on':
            'Служебный чат: трекеры, лорбуки, память, картинки и сюжетные модули Maestro здесь молчат, пресет — «{preset}».',
        'm42.notice.onNoPreset':
            'Служебный чат: трекеры, лорбуки, память, картинки и сюжетные модули Maestro здесь молчат.',
        'm42.button.off':
            'Служебный режим: сделать карточку служебной (в её чатах молчат трекеры, лорбуки и сюжетные модули)',
        'm42.button.on':
            'Служебная карточка: её чаты идут без трекеров, лорбуков и сюжетных модулей. Нажми, чтобы вернуть её в сюжетные',
        'm42.option.on': 'Служебный режим: включить для карточки',
        'm42.option.off': 'Служебный режим: вернуть в сюжетные',
        'm42.noCard': 'Сначала открой в редакторе карточку одного персонажа.',
        'm42.tag.added': 'Карточка теперь служебная: её чаты идут без сюжетной машинерии.',
        'm42.tag.removed': 'Карточка снова сюжетная.',
        'm42.tag.addFailed': 'Служебный тег не поставился: SillyTavern его не принял.',
        'm42.tag.removeFailed': 'Служебный тег не снялся: SillyTavern его не принял.',
        'm42.qvink.global':
            'У Qvink один переключатель на все чаты («Use global toggle state»), поэтому в служебном чате я его не выключал. Его пересказы в промпт служебного чата всё равно не попадают.',
        'm42.qvink.back': 'Qvink снова включён в этом чате: карточка больше не служебная.',
        'm42.journal.on': '«{name}» — теперь служебная карточка',
        'm42.journal.off': '«{name}» — снова сюжетная карточка',
        'm42.journal.qvinkOff': 'Выключил Qvink в служебном чате',
        'm42.settings.title': 'Служебный режим',
        'm42.settings.hint':
            'Карточка со служебным тегом — помощник: генератор сценариев или персонажей, редактор, соавтор. В её чатах молчат трекеры (DES), картинки, CarrotKernel, Dramatis, память Qvink, глобальные лорбуки и сюжетные модули Maestro; остаются карточка, чат, заметка автора и выбранный пресет. Тег ставит кнопка с гаечным ключом в редакторе карточки. Раньше этот режим назывался «Мастерская».',
        'm42.settings.tags': 'Теги служебных карточек',
        'm42.settings.tags.hint':
            'По одному в строке или через запятую, регистр не важен. Кнопка ставит первый; служебной считается карточка с любым из них.',
        'm42.settings.preset': 'Пресет служебных чатов',
        'm42.settings.preset.hint':
            'Включается, когда открываешь служебный чат; при выходе возвращается прежний. Модель не меняется. Пусто — пресет не переключается.',
        'm42.settings.lore': 'Лорбуки в служебных чатах',
        'm42.settings.lore.own': 'Только свои: карточки и чата',
        'm42.settings.lore.none': 'Никаких',
        'm42.settings.lore.all': 'Все, как в других чатах',
        'm42.settings.qvink': 'Выключать Qvink в служебных чатах',
        'm42.settings.qvink.hint':
            'Собственный переключатель Qvink для чата: без пересказов, и старые сообщения не выпадают из промпта. Включается обратно, когда карточка перестаёт быть служебной.',
        'm42.settings.notice': 'Сообщать, когда открывается служебный чат',
        'm42.settings.state.on': 'Открытый сейчас чат — служебный.',
        'm42.settings.state.off': 'Открытый сейчас чат — сюжетный.',
        'm42.slash.help':
            'Служебный режим: делает карточку открытого чата служебной (on), снова сюжетной (off) или переключает (без аргумента).',
        'm42.slash.value': 'on, off или ничего — переключить',
        'm42.slash.noCard': 'Сначала открой чат с одним персонажем.',
        'kind.workshop.card': 'Служебная карточка',
        'kind.workshop.qvink': 'Qvink в служебном чате',
        'target.workshop-card': 'Служебная карточка',
        'target.workshop-qvink': 'Qvink в чате',
        'm42.target.on': 'да',
        'm42.target.off': 'нет',
    },
};
