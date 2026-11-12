// Strings of release 1.34 (`m44.*`): neighbours' built-in agents, agent tools, the group host, the assistant's agent
// tools.
import type { I18nParts } from '../../shared/contracts';

export const NEIGHBOUR_STRINGS: I18nParts = {
    en: {
        'm44.biGroup.neighbours': 'Neighbours (Dramatis, Localizer, NAI Studio…)',
        'm44.bi.ownChannel':
            "This agent calls its model on its extension's own channel (chosen there): here you change only its instruction, temperature and length.",

        'm44.editor.tools': 'Tools',
        'm44.editor.toolsHint':
            'Before it answers, the agent may call these (up to 3 rounds); each round is one more request to its model. The calls are in the run log.',
        'm44.tool.roll': 'Roll dice',
        'm44.tool.roll.hint': 'By the dice engine of Mechanics: 1d20+3, 2d6, 1d100<=45, 4d6kh3.',
        'm44.tool.lore_search': 'Search the lore',
        'm44.tool.lore_search.hint': 'Entries of the chat canon by words.',
        'm44.tool.chat_search': 'Search the chat',
        'm44.tool.chat_search.hint': 'Older messages of this chat by words.',
        'm44.log.tools': 'Tool calls: {count}',
        'm44.src.groupMembers': 'Members of the group',
        'm44.recv.group.speaker': 'Who of the group answers next',
        'kind.group.speaker': 'The next speaker of a group from agents',
        'm44.group.speaks': '{name} answers',
        'm44.group.otherChat': 'Another chat is open now.',
        'm44.group.noMember': '{name} is not a member of this group (or is muted).',
        'm44.group.noGenerate': 'SillyTavern cannot start a reply here.',
        'm44.tpl.group-host.name': 'Group host',
        'm44.tpl.group-host.desc':
            "In a group chat picks who answers your message by the scene, not by turn or at random. Set the group's reply order to «Manual» in SillyTavern: then after your message the agent names the member and Maestro starts their reply.",
    },
    ru: {
        'm44.biGroup.neighbours': 'Соседи (Dramatis, Localizer, NAI Studio…)',
        'm44.bi.ownChannel':
            'Этот агент зовёт модель по своему каналу расширения (модель выбирается там): здесь меняются только поручение, температура и длина.',
        'm44.editor.tools': 'Инструменты',
        'm44.editor.toolsHint':
            'Перед ответом агент может их вызвать (до 3 кругов); каждый круг — ещё один запрос к его модели. Вызовы видны в журнале запусков.',
        'm44.tool.roll': 'Бросить кубики',
        'm44.tool.roll.hint': 'Движком кубиков «Механик»: 1d20+3, 2d6, 1d100<=45, 4d6kh3.',
        'm44.tool.lore_search': 'Искать в лоре',
        'm44.tool.lore_search.hint': 'Записи канона чата по словам.',
        'm44.tool.chat_search': 'Искать в чате',
        'm44.tool.chat_search.hint': 'Старые сообщения этого чата по словам.',
        'm44.log.tools': 'Вызовы инструментов: {count}',
        'm44.src.groupMembers': 'Участники группы',
        'm44.recv.group.speaker': 'Кто из группы отвечает следующим',
        'kind.group.speaker': 'Следующий говорящий группы от агентов',
        'm44.group.speaks': 'Отвечает {name}',
        'm44.group.otherChat': 'Сейчас открыт другой чат.',
        'm44.group.noMember': '{name} не в этой группе (или выключен).',
        'm44.group.noGenerate': 'SillyTavern не может запустить ответ здесь.',
        'm44.tpl.group-host.name': 'Ведущий группы',
        'm44.tpl.group-host.desc':
            'В групповом чате выбирает, кто ответит на твоё сообщение, — по сцене, а не по кругу или случайно. В SillyTavern поставь группе порядок ответов «Вручную»: тогда после твоего сообщения агент назовёт участника, и Maestro запустит его ответ.',
    },
};
