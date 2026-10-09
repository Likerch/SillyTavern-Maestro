// Strings of M39 «Раздел Dramatis в листе персонажа DES» (en + ru).
import type { I18nParts } from '../../shared/contracts';

export const DES_DRAMATIS_STRINGS: I18nParts = {
    en: {
        'm39.title': "Dramatis section in DES's character sheet",
        'm39.tab': 'Dramatis',
        'm39.tabTitle': 'What Dramatis knows about this character',
        'm39.menu': 'Dramatis',
        'm39.menuTitle': 'Open the character sheet on the Dramatis tab',
        'm39.empty': "Dramatis doesn't know this character yet",
        'm39.persona': 'This is your character: Dramatis keeps the personalities of the others.',
        'm39.openDramatis': 'Open Dramatis',
        'm39.openSheet': 'Open in Dramatis',
        'm39.secret': 'A secret: click to reveal',
        'm39.secretOpen': 'A secret',
        'm39.openFailed': "DES's character sheet did not open",
    },
    ru: {
        'm39.title': 'Раздел Dramatis в листе персонажа DES',
        'm39.tab': 'Dramatis',
        'm39.tabTitle': 'Что знает о персонаже Dramatis',
        'm39.menu': 'Dramatis',
        'm39.menuTitle': 'Открыть лист персонажа на вкладке Dramatis',
        'm39.empty': 'Dramatis ещё не знает этого персонажа',
        'm39.persona': 'Это твой персонаж: Dramatis ведёт личности остальных.',
        'm39.openDramatis': 'Открыть Dramatis',
        'm39.openSheet': 'Открыть в Dramatis',
        'm39.secret': 'Тайна: нажми, чтобы открыть',
        'm39.secretOpen': 'Тайна',
        'm39.openFailed': 'Лист персонажа DES не открылся',
    },
};
