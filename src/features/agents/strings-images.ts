// Strings of release 1.33 (`m44.*`, `m9.cover.*`): pictures by agents — the illustrator, the decorator, the portraitist,
// the card's avatar, chapter covers, the tab «Картинки» and the blind comparison.
import type { I18nParts } from '../../shared/contracts';

export const IMAGE_STRINGS: I18nParts = {
    en: {
        'kind.nai.illustrate': 'Pictures of replies from the illustrator',
        'kind.nai.portrait': 'Portraits from agents',
        'kind.nai.cardAvatar': 'Card avatar from agents',
        'kind.backgrounds.agentGenerate': 'Backgrounds from agents',
        'target.nai.chatPassport': 'Picture passport (this chat)',
        'target.nai.cardAvatar': 'Card avatar',
        'm44.recv.nai.illustrate': 'A picture of the reply (a marker for NAI Studio)',
        'm44.recv.nai.portrait': 'A portrait of a new face (passport and DES portrait)',
        'm44.recv.nai.cardAvatar': "A new avatar of the chat's card (always asked)",
        'm44.recv.backgrounds.agentGenerate': 'A background for the place without one',
        'm44.recv.chronicle.cover': 'A cover of a chapter of the chronicle',
        'm44.recv.illustrateTitle': 'Picture: {caption}',
        'm44.recv.illustrate.failed': 'NAI Studio did not take the picture: {error}',
        'm44.recv.portraitTitle': 'Portrait: {name}',
        'm44.recv.portrait.otherChat': 'Another chat is open now.',
        'm44.recv.portrait.noNai': 'NAI Studio is off.',
        'm44.recv.portrait.noPassport': 'NAI Studio did not write a passport for {name}.',
        'm44.recv.cardAvatarTitle': 'New avatar of the card «{name}»',
        'm44.recv.cardAvatarWarn':
            "The card's picture will be replaced. NAI Studio first saves the old one (with the card's data) into user/images/avatar-backups.",
        'm44.recv.cardAvatar.failed': 'The avatar was not set: {error}',
        'm44.recv.cardAvatar.done': 'New avatar of «{name}» is set. The old picture: {backup}',
        'm44.recv.backgroundTitle': 'Background for «{place}»',
        'm44.recv.background.failed': 'No background was drawn for «{place}».',
        'm44.src.markerRules': 'Image rules (from the preset or NAI Studio)',
        'm44.src.portraitless': 'Faces without a portrait',
        'm44.src.chapters': 'Chapters without a cover',
        'm44.tplGroup.images': 'Pictures',
        'm44.tpl.illustrator.name': 'Illustrator',
        'm44.tpl.illustrator.desc':
            "Writes the picture markers instead of the main model — the same marker, by the same image rules (your preset's block), but seeing the whole reply, the wardrobe, the staging and the place. NAI Studio draws them by its usual path. Works only with «Who writes the markers» in the tab «Pictures». Not in any set until it wins the blind comparison.",
        'm44.tpl.decorator.name': 'Decorator',
        'm44.tpl.decorator.desc':
            'When the scene is in a place the background library has nothing for, describes how the place looks now; NAI Studio draws the background (free only by default), «Backgrounds» binds and sets it with undo. Once per place.',
        'm44.tpl.portraitist.name': 'Portraitist',
        'm44.tpl.portraitist.desc':
            'A new important face without a picture passport gets one written from the story and the lore (in this chat, with undo) and, with DES, a portrait.',
        'm44.tpl.card-avatar.name': 'Card avatar',
        'm44.tpl.card-avatar.desc':
            'By your button: a new avatar of the card from how the character looks now. Always asks first; the old picture is kept as a backup.',
        'm44.tpl.chapter-covers.name': 'Chapter covers',
        'm44.tpl.chapter-covers.desc':
            'Each new chapter of the chronicle gets a cover picture; «Chronicle» shows it. Free only by default.',
        'm44.set.cinema.desc':
            'Costumer, Staging, Change of outfit, Decorator, Portraitist, Chapter covers. The illustrator joins after the blind comparison.',
        'm44.tab.images': 'Pictures',
        'm44.images.title': 'Pictures by agents',
        'm44.images.hint':
            "Agents draw through NAI Studio: the illustrator writes the markers of a reply, the decorator draws backgrounds, the portraitist new faces, covers of chapters. When to draw is still NAI Studio's rules (counters, the limit of markers, Anlas).",
        'm44.images.needNai': 'Needs NAI Studio 0.16 or newer, on.',
        'm44.images.writer': 'Who writes the markers (NAI Studio)',
        'm44.images.writer.main': 'The main model',
        'm44.images.writer.illustrator': 'The illustrator',
        'm44.images.writer.fallback': 'The illustrator, when the main model wrote none',
        'm44.images.writerNow':
            "Now: {now}. It counts only while an illustrator agent is on in this chat; with «The illustrator» the preset's image block leaves the main prompt.",
        'm44.images.paid': "Agents' pictures may spend Anlas",
        'm44.images.paidHint':
            "Off: agents' backgrounds, pictures and covers are free only — a paid request is refused before it is sent. On: NAI Studio's own rules (its limit for markers, its cost question for backgrounds).",
        'm44.ab.title': 'Blind comparison',
        'm44.ab.hint':
            'Up to 20 replies of this chat that the main model illustrated: the illustrator writes its own marker for each (a test run), both markers are drawn again by the same NAI Studio path, and you pick the better picture without knowing whose it is.',
        'm44.ab.cost':
            "{count} replies: up to {count} requests to the illustrator's model and twice as many free pictures; a few minutes.",
        'm44.ab.start': 'Compare «{name}»',
        'm44.ab.stop': 'Stop',
        'm44.ab.job': 'Blind comparison: {name}',
        'm44.ab.open': 'Open',
        'm44.ab.progress': 'Preparing pairs: {done} of {total}',
        'm44.ab.ready': 'Pairs ready: {count}',
        'm44.ab.pair': 'Pair {n} of {total} (message #{message})',
        'm44.ab.left': 'Left',
        'm44.ab.right': 'Right',
        'm44.ab.pickLeft': 'Left is better',
        'm44.ab.pickRight': 'Right is better',
        'm44.ab.same': 'The same',
        'm44.ab.noAgent': 'Take the template «Illustrator» first (tab «Templates»).',
        'm44.ab.empty': 'No pair came out: {reasons}.',
        'm44.ab.why.cost':
            'NAI Studio refused the pictures — free only, and they would cost Anlas (no Opus, or too large)',
        'm44.ab.why.noPicture': 'the illustrator proposed no picture for those replies',
        'm44.ab.why.agent': "the illustrator's model did not answer",
        'm44.ab.why.aborted': 'stopped',
        'm44.ab.why.unknown': 'NAI Studio did not draw (see its log)',
        'm44.ab.noReplies':
            'No reply of this chat has a picture by a marker of the main model (or NAI Studio is older than 0.16).',
        'm44.ab.result.agent':
            'The illustrator won: {agent} against {main} (the same: {same} of {total}). It may go into sets.',
        'm44.ab.result.tie': 'A draw: {agent} — {main} (the same: {same} of {total}). The illustrator is not worse.',
        'm44.ab.result.main':
            "The main model won: {main} against {agent} (the same: {same} of {total}). Keep the main model's markers.",
        'm44.ab.last.agent': 'Last time «{name}» won: {agent} — {main}, the same {same} of {total}.',
        'm44.ab.last.tie': 'Last time «{name}» drew: {agent} — {main}, the same {same} of {total}.',
        'm44.ab.last.main': 'Last time the main model won over «{name}»: {main} — {agent}, the same {same} of {total}.',
    },
    ru: {
        'kind.nai.illustrate': 'Картинки ответов от иллюстратора',
        'kind.nai.portrait': 'Портреты от агентов',
        'kind.nai.cardAvatar': 'Аватар карточки от агентов',
        'kind.backgrounds.agentGenerate': 'Фоны от агентов',
        'target.nai.chatPassport': 'Паспорт картинок (этот чат)',
        'target.nai.cardAvatar': 'Аватар карточки',
        'm44.recv.nai.illustrate': 'Картинка к ответу (метка для NAI Studio)',
        'm44.recv.nai.portrait': 'Портрет нового лица (паспорт и портрет DES)',
        'm44.recv.nai.cardAvatar': 'Новый аватар карточки чата (всегда с вопросом)',
        'm44.recv.backgrounds.agentGenerate': 'Фон для места, у которого его нет',
        'm44.recv.chronicle.cover': 'Обложка главы летописи',
        'm44.recv.illustrateTitle': 'Картинка: {caption}',
        'm44.recv.illustrate.failed': 'NAI Studio не приняла картинку: {error}',
        'm44.recv.portraitTitle': 'Портрет: {name}',
        'm44.recv.portrait.otherChat': 'Сейчас открыт другой чат.',
        'm44.recv.portrait.noNai': 'NAI Studio выключена.',
        'm44.recv.portrait.noPassport': 'NAI Studio не написала паспорт для {name}.',
        'm44.recv.cardAvatarTitle': 'Новый аватар карточки «{name}»',
        'm44.recv.cardAvatarWarn':
            'Картинка карточки заменится. NAI Studio сначала сохранит старую (вместе с данными карточки) в user/images/avatar-backups.',
        'm44.recv.cardAvatar.failed': 'Аватар не поставлен: {error}',
        'm44.recv.cardAvatar.done': 'Новый аватар «{name}» поставлен. Старая картинка: {backup}',
        'm44.recv.backgroundTitle': 'Фон для «{place}»',
        'm44.recv.background.failed': 'Фон для «{place}» не нарисован.',
        'm44.src.markerRules': 'Правила картинок (из пресета или NAI Studio)',
        'm44.src.portraitless': 'Лица без портрета',
        'm44.src.chapters': 'Главы без обложки',
        'm44.tplGroup.images': 'Картинки',
        'm44.tpl.illustrator.name': 'Иллюстратор',
        'm44.tpl.illustrator.desc':
            'Пишет метки картинок вместо основной модели — ту же метку, по тем же правилам (твой блок из пресета), но видит весь ответ, гардероб, мизансцену и место. NAI Studio рисует их своим обычным путём. Работает только вместе с «Кто пишет метки» во вкладке «Картинки». Ни в какой набор не входит, пока не выиграет сравнение вслепую.',
        'm44.tpl.decorator.name': 'Декоратор',
        'm44.tpl.decorator.desc':
            'Когда сцена в месте, для которого в библиотеке фонов ничего нет, описывает, как оно выглядит сейчас; NAI Studio рисует фон (по умолчанию только бесплатно), «Фоны» привязывают его к месту и ставят с откатом. Один раз на место.',
        'm44.tpl.portraitist.name': 'Портретист',
        'm44.tpl.portraitist.desc':
            'Новое важное лицо без паспорта картинок получает паспорт по сюжету и лору (в этом чате, с откатом), а с DES — портрет.',
        'm44.tpl.card-avatar.name': 'Аватар карточки',
        'm44.tpl.card-avatar.desc':
            'По твоей кнопке: новый аватар карточки по тому, как персонаж выглядит сейчас. Всегда спрашивает; старая картинка сохраняется копией.',
        'm44.tpl.chapter-covers.name': 'Обложки глав',
        'm44.tpl.chapter-covers.desc':
            'Каждая новая глава летописи получает картинку-обложку; её видно в «Летописи». По умолчанию только бесплатно.',
        'm44.set.cinema.desc':
            'Костюмер, Мизансцена, Смена наряда, Декоратор, Портретист, Обложки глав. Иллюстратор добавится после сравнения вслепую.',
        'm44.tab.images': 'Картинки',
        'm44.images.title': 'Картинки агентов',
        'm44.images.hint':
            'Агенты рисуют через NAI Studio: иллюстратор пишет метки ответа, декоратор — фоны, портретист — новые лица, обложки — главы. Когда рисовать, по-прежнему решают правила NAI Studio (счётчики, лимит меток, Anlas).',
        'm44.images.needNai': 'Нужна включённая NAI Studio 0.16 или новее.',
        'm44.images.writer': 'Кто пишет метки (NAI Studio)',
        'm44.images.writer.main': 'Основная модель',
        'm44.images.writer.illustrator': 'Иллюстратор',
        'm44.images.writer.fallback': 'Иллюстратор, если основная модель не поставила метку',
        'm44.images.writerNow':
            'Сейчас: {now}. Действует, только пока в этом чате включён агент-иллюстратор; при «Иллюстратор» блок картинок пресета уходит из основного промпта.',
        'm44.images.paid': 'Картинки агентов могут тратить Anlas',
        'm44.images.paidHint':
            'Выключено: фоны, картинки и обложки агентов только бесплатные — платный запрос отклоняется до отправки. Включено: правила самой NAI Studio (её лимит для меток, её вопрос о цене для фонов).',
        'm44.ab.title': 'Сравнение вслепую',
        'm44.ab.hint':
            'До 20 ответов этого чата, которые проиллюстрировала основная модель: иллюстратор пишет к каждому свою метку (пробный прогон), обе метки рисуются заново одним путём NAI Studio, а ты выбираешь лучшую картинку, не зная, чья она.',
        'm44.ab.cost':
            'Ответов: {count}. До {count} запросов к модели иллюстратора и вдвое больше бесплатных картинок; несколько минут.',
        'm44.ab.start': 'Сравнить «{name}»',
        'm44.ab.stop': 'Остановить',
        'm44.ab.job': 'Сравнение вслепую: {name}',
        'm44.ab.open': 'Открыть',
        'm44.ab.progress': 'Готовлю пары: {done} из {total}',
        'm44.ab.ready': 'Пар готово: {count}',
        'm44.ab.pair': 'Пара {n} из {total} (сообщение №{message})',
        'm44.ab.left': 'Левая',
        'm44.ab.right': 'Правая',
        'm44.ab.pickLeft': 'Левая лучше',
        'm44.ab.pickRight': 'Правая лучше',
        'm44.ab.same': 'Одинаково',
        'm44.ab.noAgent': 'Сначала возьми шаблон «Иллюстратор» (вкладка «Шаблоны»).',
        'm44.ab.empty': 'Ни одной пары не вышло: {reasons}.',
        'm44.ab.why.cost':
            'NAI Studio отказалась рисовать — только бесплатно, а картинки стоили бы Anlas (нет Opus или слишком большие)',
        'm44.ab.why.noPicture': 'иллюстратор не предложил картинок к этим ответам',
        'm44.ab.why.agent': 'модель иллюстратора не ответила',
        'm44.ab.why.aborted': 'остановлено',
        'm44.ab.why.unknown': 'NAI Studio не нарисовала (подробности в её журнале)',
        'm44.ab.noReplies':
            'В этом чате нет ответов с картинкой по метке основной модели (или NAI Studio старше 0.16).',
        'm44.ab.result.agent':
            'Иллюстратор выиграл: {agent} против {main} (одинаково: {same} из {total}). Его можно брать в наборы.',
        'm44.ab.result.tie': 'Ничья: {agent} — {main} (одинаково: {same} из {total}). Иллюстратор не хуже.',
        'm44.ab.result.main':
            'Выиграла основная модель: {main} против {agent} (одинаково: {same} из {total}). Оставь метки основной модели.',
        'm44.ab.last.agent': 'В прошлый раз «{name}» выиграл: {agent} — {main}, одинаково {same} из {total}.',
        'm44.ab.last.tie': 'В прошлый раз у «{name}» ничья: {agent} — {main}, одинаково {same} из {total}.',
        'm44.ab.last.main':
            'В прошлый раз основная модель выиграла у «{name}»: {main} — {agent}, одинаково {same} из {total}.',
    },
};
