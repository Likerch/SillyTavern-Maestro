// Scenario engine of the Maestro mock LLM (tools/mock-llm/server.mjs).
//
// analyseRequest() reads an OpenAI-style chat completion body, buildReply() turns it into a reply:
// - story replies in the DES together mode (a ```json tracker block first, then Russian prose);
// - markers `[mock:<name>]` in the trailing user turn switch to defective replies (see README.md);
// - `response_format: json_schema` requests get JSON for the schema (registered handlers or a schema walker);
// - `tools` requests get a tool call when the message asks for one.
// Everything is deterministic for the same request: the random generator is seeded from the request text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ small helpers */

/** FNV-1a, 32 bit. Stable seed for the same request. */
export function hashString(text) {
    let h = 0x811c9dc5;
    const s = String(text ?? '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** mulberry32: tiny seeded PRNG returning floats in [0, 1). */
export function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick(rng, list) {
    return list[Math.floor(rng() * list.length) % list.length];
}

function shuffled(rng, list) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

function fill(template, vars) {
    return template.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

/** Text of a chat message: string content, or the text parts of a multimodal content array. */
export function messageText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part?.type === 'text') return part.text ?? '';
                if (part?.type === 'image_url') return '[image]';
                return '';
            })
            .join('\n');
    }
    return '';
}

/** Rough token estimate (≈4 UTF-8 bytes per token: ~4 Latin or ~2 Cyrillic characters). */
export function estimateTokens(text) {
    const bytes = Buffer.byteLength(String(text ?? ''), 'utf8');
    return bytes === 0 ? 0 : Math.max(1, Math.ceil(bytes / 4));
}

/* ------------------------------------------------------------------ story data */

export const DEFAULT_NAMES = ['Элизабет', 'Вера', 'Мартин'];
export const DEFAULT_LOCATION = 'Серебряная Гавань';
export const DEFAULT_USER = 'Кай';

const FEMALE_NAMES = new Set(['Элизабет', 'Вера', 'Александра', 'Огда', 'Илза', 'Ингрид', 'Мария']);

const PROFILES = {
    Элизабет: { title: 'Наследница торгового дома Арден', mbti: 'ENFJ-U', dere: 'HIMEDERE', age: 24, hair: 'AUBURN' },
    Вера: { title: 'Капитан портовой стражи', mbti: 'ISTJ-H', dere: 'KUUDERE', age: 29, hair: 'BLACK' },
    Мартин: { title: 'Алхимик и архивариус гильдии', mbti: 'INTP-H', dere: 'DANDERE', age: 33, hair: 'BROWN' },
    Александр: { title: 'Начальник порта', mbti: 'ESTJ-U', dere: 'TSUNDERE', age: 41, hair: 'GREY' },
    Александра: { title: 'Картограф гильдии', mbti: 'INFP-H', dere: 'DEREDERE', age: 26, hair: 'BLONDE' },
};

const NAME_STOP = new Set(
    (
        'Она Он Оно Они Это Эта Этот Эти Его Её Ее Их Мы Вы Ты Я Но И А В Во На Не Ни Что Чем Как Где Когда Если Там Тут ' +
        'Здесь Только Всё Все Так Да Нет Ну Кто Почему Зачем Потом Теперь Сейчас Ещё Еще Уже Даже Вот Тогда После Перед ' +
        'Над Под Из За По С К О От До Для При Без Через Между Около Пока Может Можно Нужно Надо Хорошо Ладно Спасибо ' +
        'Привет Конечно Просто Сначала Затем Наконец Внутри Снаружи Рядом Вдруг Однако Впрочем Кажется Похоже Словно ' +
        'Будто Тишина Ветер Дождь Колокол Дорога Разговор Время Свет Где-то Никто Ничто Каждый Один Одна Два Три Мой Моя ' +
        'Твой Твоя Наш Наша Ваш Ваша Сегодня Завтра Вчера Утро Вечер Ночь День Иллюстрация Раздел Лист Имя'
    ).split(' '),
);

const EN_STOP = new Set(['CharacterName', 'Character Emoji', 'Quest title', 'Location', 'Name']);

const WEATHER = [
    { emoji: '🌧️', forecast: 'Rain', ru: 'Моросит дождь', en: 'A thin rain is falling' },
    { emoji: '🌫️', forecast: 'Fog', ru: 'С моря наползает туман', en: 'Fog creeps in from the sea' },
    { emoji: '☁️', forecast: 'Overcast', ru: 'Небо затянуто тучами', en: 'The sky is overcast' },
    { emoji: '💨', forecast: 'Wind', ru: 'Порывистый ветер гонит листья', en: 'A gusty wind chases leaves' },
    { emoji: '⛈️', forecast: 'Storm', ru: 'Над заливом собирается гроза', en: 'A storm gathers over the bay' },
    { emoji: '☀️', forecast: 'Clear', ru: 'Холодное ясное небо', en: 'The sky is cold and clear' },
];

const TEXT = {
    ru: {
        openers: [
            '{P} встречает их запахом соли и мокрого камня.',
            '{P} к вечеру затихает: торговцы сворачивают навесы, а стража лениво обходит улицы.',
            '{P} живёт своей жизнью: дети гоняют по лужам бумажный кораблик, где-то хлопает ставня.',
            'В воздухе пахнет дымом и дождём. {W}.',
            'Колокол на башне отбивает время, и эхо долго гуляет между стенами.',
            'Свет фонарей дрожит на мокрой мостовой. {W}.',
            '{W}, и редкие прохожие торопятся спрятаться под навесами.',
        ],
        actions: [
            '{X} поднимает взгляд от карты и на мгновение задерживает его на двери.',
            '{X} молча кивает и проводит пальцем по краю стола, будто проверяя, не осталось ли на нём пыли.',
            '{X} усмехается, не скрывая усталости, и отворачивается к окну.',
            '{X} появляется в проёме с фонарём в руке; свет выхватывает из темноты мокрый плащ и связку ключей.',
            '{X} присаживается у очага и протягивает к огню озябшие ладони.',
            '{X} разворачивает свёрток: внутри потёртая тетрадь, исписанная мелким почерком, и сухая веточка вереска.',
            '{X} барабанит пальцами по рукояти ножа и не сводит глаз с улицы.',
            '{X} достаёт из сумки медный компас и долго смотрит на дрожащую стрелку.',
            '{X} складывает руки на груди и прислоняется к косяку, наблюдая за остальными.',
        ],
        lines: [
            '«Если выйдем сейчас, успеем до прилива», — говорит {X} вполголоса.',
            '«Здесь кто-то был до нас», — замечает {X}, указывая на ещё тёплый пепел в очаге.',
            '«Ты же знаешь, что так просто это не закончится», — бросает {X}.',
            '«Мы можем попробовать ещё раз, — предлагает {X}. — Только на этот раз без спешки».',
            '«Не нравится мне эта тишина», — признаётся {X}.',
            '«Печать подлинная. Вопрос в том, кто ею пользовался», — задумчиво произносит {X}.',
            '«Слушай внимательно, {U}: второй попытки не будет», — тихо говорит {X}.',
        ],
        closers: [
            'Разговор затихает, но напряжение никуда не уходит.',
            'Где-то вдалеке кричат чайки, и в этом крике слышится тревога.',
            'Никто не решается заговорить первым.',
            'Дождь усиливается, барабаня по черепице.',
            'Время уходит, и все это понимают.',
            'Огонь в очаге потрескивает, отбрасывая на стены длинные тени.',
        ],
        user: [
            '{U} делает шаг вперёд и кладёт ладонь на рукоять меча. «Я пойду первым», — говорит {U}, не дожидаясь ответа.',
            '{U} чувствует, как внутри поднимается тревога, и всё же улыбается спутникам. «Хорошо, — отвечает {U}. — Тогда решено».',
            '{U} молча берёт фонарь со стола, проверяет масло и первым выходит под дождь, думая о том, что отступать уже поздно.',
        ],
        invent: [
            [
                'праздник Семи Фонарей',
                'Сегодня в городе отмечают {T} — старинный обычай: в каждое окно ставят по фонарю, чтобы корабли нашли дорогу домой.',
            ],
            [
                'орден Пепельной Лилии',
                '{X} упоминает {T} — тайное братство, которое, по слухам, хранит ключи от всех портовых складов.',
            ],
            [
                'квартал Медных Колоколов',
                'Дорога ведёт через {T}: узкие улочки, где на каждом доме висит маленький медный колокольчик.',
            ],
            [
                'остров Безымянного Кормчего',
                'На старой карте отмечен {T} — клочок суши, которого нет ни в одном судовом журнале.',
            ],
            ['Ярмарка Пустых Сетей', 'Через три дня начнётся {T}: рыбаки выставляют на продажу всё, кроме улова.'],
            ['Башня Звёздочётов Ориса', 'Над крышами виднеется {T}, где, говорят, до сих пор горит свет по ночам.'],
            [
                'деревня Тихая Заводь',
                '{X} предлагает переждать непогоду в месте под названием {T}, в полудне пути отсюда.',
            ],
        ],
        // Like real DES: one «appearance» text with the features and the clothes (DES has no outfit field).
        appearance: [
            // wear: as the appearance text says it; outfit: the same for a clothing field.
            {
                look: 'Высокая, волосы собраны в тугую косу',
                wear: 'в тёмном плаще, промокшем у подола',
                outfit: 'Тёмный плащ, промокший у подола, высокие сапоги',
            },
            {
                look: 'Худощавый, рыжие кудри, веснушки',
                wear: 'в кожаной куртке с латунными пряжками',
                outfit: 'Кожаная куртка с латунными пряжками, холщовые штаны',
            },
            {
                look: 'Очки на цепочке, пальцы в пятнах чернил',
                wear: 'в сером сюртуке',
                outfit: 'Серый сюртук, белая рубашка',
            },
            {
                look: 'Коротко стриженный, шрам над бровью',
                wear: 'в мундире стражи с потёртой нашивкой',
                outfit: 'Мундир стражи, сапоги',
            },
            {
                look: 'Светлые волосы до плеч, внимательный взгляд',
                wear: 'в дорожной накидке, через плечо сумка',
                outfit: 'Дорожная накидка, сумка через плечо',
            },
            {
                look: 'Смуглая кожа, тёмные глаза',
                wear: 'в льняной рубахе и шерстяном жилете',
                outfit: 'Льняная рубаха, шерстяной жилет',
            },
        ],
        demeanor: [
            'Насторожённость, взгляд скользит по толпе',
            'Сдержанное любопытство',
            'Усталость, но держится прямо',
            'Скрытое раздражение',
            'Тихая решимость',
            'Лёгкая тревога',
        ],
        thoughts: [
            'Если груз не найдётся до рассвета, всё пойдёт прахом.',
            'Слишком тихо для портового вечера.',
            'Нужно проверить печати ещё раз.',
            '{U} знает больше, чем говорит.',
            'Лишь бы погода продержалась до утра.',
            'Кто-то в гильдии лжёт. Осталось понять кто.',
        ],
        quests: [
            'Найти пропавший груз «Северной звезды»',
            'Раскрыть подлог в картах гильдии',
            'Вернуть свет маяку до шторма',
            'Доставить письмо настоятелю',
        ],
        optional: [
            'Расспросить смотрителя маяка',
            'Починить фонарь',
            'Вернуть долг трактирщику',
            'Найти свидетеля на причалах',
        ],
        events: [
            'Спутники добрались до таверны',
            'Найдена сломанная печать',
            'Стража перекрыла причалы',
            'В архиве пропала карта',
        ],
        date: 'Вторник, 4 Листопада, 1247',
        summary: [
            '{A} и {U} обсудили дальнейший план и решили не терять времени.',
            '{U} и {A} нашли важную улику и договорились держать находку в тайне.',
            '{A} и {B} поспорили о том, кому можно доверять в гильдии.',
        ],
        refusal: [
            'Я не могу продолжить эту сцену в таком виде.',
            'Подобные описания могут причинить реальный вред и закрепить опасные стереотипы. Важно помнить, что даже в вымышленных историях мы несём ответственность за то, что создаём, и за то, какие идеи транслируем. Давайте сделаем паузу и подумаем, к чему на самом деле ведёт этот сюжет.',
            'Если хочешь, я могу предложить другое направление: например, сосредоточиться на диалоге персонажей, их мотивах и последствиях решений — это сделает историю глубже и безопаснее для всех.',
        ],
    },
    en: {
        openers: [
            '{P} greets them with the smell of salt and wet stone.',
            'By evening {P} falls quiet: traders fold their awnings and the watch strolls the streets.',
            'The air smells of smoke and rain. {W}.',
            'The bell in the tower strikes the hour, and the echo lingers between the walls.',
            'Lantern light trembles on the wet cobbles. {W}.',
        ],
        actions: [
            '{X} looks up from the map and lets the gaze rest on the door for a moment.',
            '{X} nods silently and runs a finger along the edge of the table.',
            '{X} smirks, not hiding the fatigue, and turns to the window.',
            '{X} appears in the doorway with a lantern; the light catches a wet cloak and a ring of keys.',
            '{X} sits down by the hearth and stretches cold hands toward the fire.',
            '{X} takes a brass compass out of the bag and watches the trembling needle.',
        ],
        lines: [
            '"If we leave now, we will make it before the tide," {X} says quietly.',
            '"Someone was here before us," {X} remarks, pointing at the still warm ashes.',
            '"You know it will not end that easily," {X} throws in.',
            '"We can try again," {X} offers. "Only without haste this time."',
            '"I do not like this silence," {X} admits.',
        ],
        closers: [
            'The conversation dies down, but the tension stays.',
            'Somewhere far away gulls cry, and there is alarm in their voices.',
            'Nobody dares to speak first.',
            'The rain grows heavier, drumming on the roof tiles.',
        ],
        user: [
            '{U} steps forward and rests a hand on the sword hilt. "I will go first," {U} says without waiting for an answer.',
            '{U} feels the worry rising and still smiles at the companions. "Fine," {U} replies. "Then it is settled."',
        ],
        invent: [
            [
                'the Festival of Seven Lanterns',
                'Tonight the town celebrates {T}, an old custom: a lantern in every window so the ships can find their way home.',
            ],
            [
                'the Order of the Ash Lily',
                '{X} mentions {T}, a secret brotherhood said to hold the keys to every harbour warehouse.',
            ],
            [
                'the Copper Bells quarter',
                'The road leads through {T}, narrow lanes where a small copper bell hangs on every house.',
            ],
        ],
        appearance: [
            {
                look: 'Tall, hair in a tight braid',
                wear: 'wearing a dark cloak, wet at the hem',
                outfit: 'Dark cloak, wet at the hem, high boots',
            },
            {
                look: 'Lean, red curls and freckles',
                wear: 'wearing a leather jacket with brass buckles',
                outfit: 'Leather jacket with brass buckles, canvas trousers',
            },
            {
                look: 'Spectacles on a chain, ink-stained fingers',
                wear: 'wearing a grey frock coat',
                outfit: 'Grey frock coat, white shirt',
            },
        ],
        demeanor: ['Watchful, eyes sliding over the crowd', 'Restrained curiosity', 'Tired but standing straight'],
        thoughts: [
            'If the cargo is not found by dawn, everything is lost.',
            'Too quiet for a harbour evening.',
            '{U} knows more than they say.',
        ],
        quests: ['Find the missing cargo of the Northern Star', 'Uncover the forgery in the guild charts'],
        optional: ['Question the lighthouse keeper', 'Repair the lantern'],
        events: ['The companions reached the tavern', 'A broken seal was found'],
        date: 'Tuesday, 4 Leaffall, 1247',
        summary: ['{A} and {U} discussed the plan and decided not to waste time.'],
        refusal: [
            "I'm sorry, but I can't continue with this scene.",
            "Descriptions like this can cause real harm and reinforce dangerous stereotypes. It's important to remember that even in fiction we are responsible for what we create and for the ideas we spread. Let's pause and think about where this story is really going.",
            'If you like, I can suggest another direction: focusing on the characters, their motives and the consequences of their choices would make the story deeper and safer for everyone.',
        ],
    },
};

/* ------------------------------------------------------------------ request analysis */

const MARKER_RE = /\[mock:([a-z0-9_-]+)(?::([^\]\n]*))?\]/gi;

const BASE_KINDS = ['sheet', 'refusal', 'repeat', 'summary'];
const FLAG_MARKERS = [
    'english',
    'user',
    'invent',
    'nojson',
    'bos',
    'truncate',
    'reasoning',
    'badjson',
    'fenced',
    'tool',
    'outfit',
    'wear',
    'stat',
    'mechblock',
    'mechextract',
];

/** Marker names this engine understands (for README and the /__config validation). */
export const KNOWN_MARKERS = [...BASE_KINDS, ...FLAG_MARKERS, 'default', 'story'];

/** All `[mock:x]` / `[mock:x:arg]` markers of a text. */
export function parseMarkers(text) {
    const markers = new Map();
    for (const match of String(text ?? '').matchAll(MARKER_RE)) {
        markers.set(match[1].toLowerCase(), (match[2] ?? '').trim());
    }
    return markers;
}

function isSummaryRequest(text) {
    return /summarization assistant|summarize the given|summarise the given/i.test(text);
}

/**
 * Character names mentioned in the request: names from DES tracker JSON first (most recent last),
 * then capitalised Cyrillic words that occur at least twice in the middle of a sentence.
 */
export function extractNames(texts, userName, systemTexts = []) {
    const fromJson = [];
    for (const text of texts) {
        for (const match of text.matchAll(/"name"\s*:\s*"([^"\n]{2,40})"(?!\s*,\s*"value")/g)) {
            // A `{"name": "Health", "value": …}` object is a DES stat, not a character.
            const name = match[1].trim();
            if (!/\p{L}/u.test(name) || EN_STOP.has(name) || name.includes('{{') || name === userName) continue;
            const index = fromJson.indexOf(name);
            if (index >= 0) fromJson.splice(index, 1);
            fromJson.push(name);
        }
    }
    if (fromJson.length > 0) return fromJson.slice(-4);

    const countWords = (list) => {
        const counts = new Map();
        for (const text of list) {
            for (const match of text.matchAll(/(^|[^\p{L}])([А-ЯЁ][а-яё]{2,}(?:-[А-ЯЁ][а-яё]+)?)/gmu)) {
                const word = match[2];
                const start = match.index + match[1].length;
                if (NAME_STOP.has(word) || word === userName || start === 0) continue;
                // Skip sentence-initial words (capitalised anyway) and multi-word proper names such as
                // «Серебряная Гавань» (places far more often than characters).
                if (/[.!?…»"*([\n]\s*$/.test(text.slice(Math.max(0, start - 3), start))) continue;
                if (/^ [А-ЯЁ]/.test(text.slice(start + word.length, start + word.length + 2))) continue;
                if (/[А-ЯЁ][а-яё]+ $/.test(text.slice(Math.max(0, start - 30), start))) continue;
                counts.set(word, (counts.get(word) ?? 0) + 1);
            }
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    };
    const repeated = countWords(texts).filter(([, count]) => count >= 2);
    // A short request (a test, a fresh chat) may name each character once: trust the system prompt then.
    const ranked = repeated.length > 0 ? repeated : countWords(systemTexts);
    return ranked.slice(0, 4).map(([word]) => word);
}

/** Last match of a regex over all texts whose first group is not a placeholder of a format template. */
function lastMatch(texts, regex, placeholder = /^$/) {
    let found = null;
    for (const text of texts) {
        for (const match of text.matchAll(regex)) {
            if (!placeholder.test(match[1])) found = match;
        }
    }
    return found;
}

/**
 * Reads everything the scenarios need from a request body.
 * @param {any} body OpenAI chat completion request body
 * @param {{scenario?: string, userName?: string}} [overrides] forced scenario and user name (env, headers, /__config)
 */
export function analyseRequest(body, overrides = {}) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const texts = messages.map(messageText);

    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
            lastUserIndex = i;
            break;
        }
    }
    // The trailing user turn: everything after the last assistant message that precedes the last user
    // message. Depth-0 injections (BunnyMo commands, author's notes) land there too; a trailing assistant
    // prefill does not.
    let turnStart = 0;
    for (let i = lastUserIndex - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant') {
            turnStart = i + 1;
            break;
        }
    }
    const trailing = [];
    const trailingUser = [];
    if (lastUserIndex >= 0) {
        for (let i = turnStart; i < messages.length; i++) {
            if (messages[i]?.role === 'user' || messages[i]?.role === 'system') trailing.push(texts[i]);
            if (messages[i]?.role === 'user') trailingUser.push(texts[i]);
        }
    }
    const trailingText = trailing.join('\n');
    const lastUserText = lastUserIndex >= 0 ? texts[lastUserIndex] : '';

    let lastAssistantText = '';
    for (let i = (lastUserIndex >= 0 ? lastUserIndex : messages.length) - 1; i >= 0; i--) {
        if (messages[i]?.role === 'assistant' && texts[i].trim()) {
            lastAssistantText = texts[i];
            break;
        }
    }

    const markers = parseMarkers(trailingText);
    for (const forced of String(overrides.scenario ?? '')
        .split(/[,+\s]+/)
        .filter(Boolean)) {
        const [name, arg = ''] = forced.split(':');
        markers.set(name.toLowerCase(), arg);
    }

    const userName =
        overrides.userName ||
        messages.find((m) => m?.role === 'user' && typeof m.name === 'string' && m.name)?.name ||
        DEFAULT_USER;

    const names = extractNames(
        texts,
        userName,
        texts.filter((_, i) => messages[i]?.role === 'system'),
    );
    // DES puts the previous tracker state into the prompt; its format template uses placeholders.
    const locationMatch = lastMatch(texts, /"location"\s*:\s*\{\s*"value"\s*:\s*"([^"\n]{2,80})"/g, /^Location$/);
    const location = locationMatch ? locationMatch[1] : null;
    const timeMatch = lastMatch(texts, /"time"\s*:\s*\{[^}]*?"end"\s*:\s*"(\d{1,2}):(\d{2})"/g);
    const dateMatch = lastMatch(texts, /"date"\s*:\s*\{\s*"value"\s*:\s*"([^"\n]{4,60})"/g, /Weekday|Month, Year/i);

    const format = body?.response_format;
    const schema =
        format?.type === 'json_schema' && format.json_schema
            ? { name: String(format.json_schema.name ?? 'unnamed'), schema: format.json_schema.schema ?? {} }
            : null;

    // A sheet command typed by the user: at the start of a line of a user message (optionally after "Name: ").
    // Instructions that merely mention !fullsheet (BunnyMo entries, DES-RU's language lock) do not count.
    const sheetMatch = trailingUser
        .join('\n')
        .match(/(?:^|\n)[ \t]*(?:[^\n:!]{1,40}:[ \t]*)?!fullsheet\b[ \t]*([^\n,.!?]*)/i);

    return {
        messages,
        texts,
        model: String(body?.model ?? 'mock'),
        lastUserText,
        trailingText,
        lastAssistantText,
        lastRole: messages.at(-1)?.role ?? null,
        markers,
        userName,
        names,
        location,
        lastTime: timeMatch ? { h: Number(timeMatch[1]), m: Number(timeMatch[2]) } : null,
        lastDate: dateMatch ? dateMatch[1] : null,
        schema,
        jsonObject: format?.type === 'json_object',
        tools: Array.isArray(body?.tools) ? body.tools : [],
        toolChoice: body?.tool_choice,
        summary: isSummaryRequest(trailingText) || markers.has('summary'),
        sheetTarget: markers.has('sheet')
            ? markers.get('sheet') || null
            : sheetMatch
              ? sheetMatch[1].trim() || null
              : null,
        wantsSheet: markers.has('sheet') || Boolean(sheetMatch),
        seed: hashString(`${messages.length}\n${trailingText}\n${lastAssistantText.slice(0, 200)}`),
    };
}

/* ------------------------------------------------------------------ JSON schema support */

const schemaHandlers = new Map();
const toolHandlers = new Map();

/**
 * Registers a reply for a json_schema name. The handler returns a partial object; missing required
 * properties are filled from the schema, unknown keys are dropped when the schema forbids them.
 * @param {string} name schema name (`response_format.json_schema.name`)
 * @param {(ctx: ReturnType<typeof analyseRequest>, rng: () => number) => unknown} handler
 */
export function registerSchema(name, handler) {
    schemaHandlers.set(name, handler);
}

/** Registers arguments for a tool call by function name (same filling rules as registerSchema). */
export function registerTool(name, handler) {
    toolHandlers.set(name, handler);
}

/* ------------------------------------------------------------------ Dramatis tasks (Maestro 1.17) */

// MAESTRO_API names the JSON schema of a neighbour's request after its task (`dramatis.turn` → `dramatis_turn`,
// src/app/public-api.ts schemaNameOf), so the mock knows the task. The reply for a `dramatis_*` schema comes from, in
// this order: a handler registered with registerTask(task, handler); a fixture file
// `tools/mock-llm/fixtures/dramatis/<task>.json` (or `<schema name>.json`; MOCK_DRAMATIS_FIXTURES moves the folder)
// holding a partial object, or an array of them (one is picked per request); else the schema walker alone — a valid
// object with every required field. Missing required fields are always filled from the schema.

const taskHandlers = new Map();
const fixtureCache = new Map();

/** The JSON schema name MAESTRO_API sends for a task. */
export function taskSchemaName(task) {
    return String(task)
        .replace(/[^A-Za-z0-9_-]/g, '_')
        .slice(0, 64);
}

/** True for a schema MAESTRO_API sent for a Dramatis task. */
export function isDramatisSchema(name) {
    return typeof name === 'string' && name.startsWith('dramatis_');
}

/** Registers a reply for a Dramatis task id (`dramatis.turn`); same filling rules as registerSchema. */
export function registerTask(task, handler) {
    taskHandlers.set(taskSchemaName(task), handler);
}

function fixtureDir() {
    return process.env.MOCK_DRAMATIS_FIXTURES || fileURLToPath(new URL('./fixtures/dramatis/', import.meta.url));
}

/** The fixture of a schema name: `<task>.json` (dots) or `<schema name>.json`; null when there is none. */
export function taskFixture(name) {
    const dir = fixtureDir();
    const key = `${dir}|${name}`;
    if (fixtureCache.has(key)) return fixtureCache.get(key);
    let value = null;
    const task = name.replace(/^dramatis_/, 'dramatis.');
    for (const file of [`${name}.json`, `${task}.json`]) {
        const full = path.join(dir, file);
        if (!fs.existsSync(full)) continue;
        try {
            value = JSON.parse(fs.readFileSync(full, 'utf8'));
        } catch (error) {
            console.error(`[mock-llm] fixture ${full} is not valid JSON: ${error.message}`);
        }
        break;
    }
    fixtureCache.set(key, value);
    return value;
}

/** The reply source of a Dramatis schema: a registered handler, a fixture, or the walker ('walker'). */
function dramatisHandler(name) {
    const registered = taskHandlers.get(name);
    if (registered) return { handler: registered, how: 'task' };
    const fixture = taskFixture(name);
    if (fixture !== null && fixture !== undefined) {
        const handler = (ctx, rng) => {
            const value = Array.isArray(fixture) ? fixture[Math.floor(rng() * fixture.length)] : fixture;
            return JSON.parse(JSON.stringify(value ?? {}));
        };
        return { handler, how: 'fixture' };
    }
    return { handler: null, how: 'walker' };
}

function resolveRef(ref, root) {
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return {};
    let node = root;
    for (const part of ref.slice(2).split('/')) {
        node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
    }
    return node ?? {};
}

function deref(schema, root, depth = 0) {
    let node = schema ?? {};
    while (node && typeof node === 'object' && node.$ref && depth < 16) {
        node = resolveRef(node.$ref, root);
        depth++;
    }
    if (node && Array.isArray(node.allOf)) {
        const merged = { type: 'object', properties: {}, required: [] };
        for (const part of node.allOf) {
            const sub = deref(part, root, depth + 1);
            Object.assign(merged.properties, sub.properties ?? {});
            merged.required.push(...(sub.required ?? []));
        }
        const rest = { ...node };
        delete rest.allOf;
        return { ...rest, ...merged };
    }
    if (node && (Array.isArray(node.anyOf) || Array.isArray(node.oneOf))) {
        const options = node.anyOf ?? node.oneOf;
        const first = options.find((o) => deref(o, root, depth + 1).type !== 'null') ?? options[0];
        return deref(first, root, depth + 1);
    }
    return node ?? {};
}

function primaryType(node) {
    if (Array.isArray(node.type)) return node.type.find((t) => t !== 'null') ?? 'null';
    if (node.type) return node.type;
    if (node.properties) return 'object';
    if (node.items) return 'array';
    if (node.enum) return typeof node.enum[0];
    return 'string';
}

/**
 * Builds the smallest value that satisfies a JSON schema: required properties only, `minItems` items,
 * the first enum value, numbers inside their bounds. Supports $ref, allOf, anyOf/oneOf, nullable types.
 */
export function synthesizeFromSchema(schema, root = schema, depth = 0, hint = 'value') {
    const node = deref(schema, root);
    if ('const' in node) return node.const;
    if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
    if ('default' in node && node.default !== undefined) return node.default;
    if (depth > 10) return null;
    switch (primaryType(node)) {
        case 'object': {
            const result = {};
            for (const key of node.required ?? []) {
                result[key] = synthesizeFromSchema(node.properties?.[key] ?? {}, root, depth + 1, key);
            }
            return result;
        }
        case 'array': {
            const count = Math.max(node.minItems ?? 0, 0);
            return Array.from({ length: count }, () => synthesizeFromSchema(node.items ?? {}, root, depth + 1, hint));
        }
        case 'integer': {
            const min = node.minimum ?? (node.exclusiveMinimum !== undefined ? node.exclusiveMinimum + 1 : 0);
            const max = node.maximum ?? (node.exclusiveMaximum !== undefined ? node.exclusiveMaximum - 1 : Infinity);
            return Math.min(Math.ceil(min), Math.floor(max));
        }
        case 'number': {
            const min = node.minimum ?? (node.exclusiveMinimum !== undefined ? node.exclusiveMinimum + 0.5 : 0);
            const max = node.maximum ?? (node.exclusiveMaximum !== undefined ? node.exclusiveMaximum - 0.5 : Infinity);
            return Math.min(min, max);
        }
        case 'boolean':
            return false;
        case 'null':
            return null;
        default: {
            if (node.format === 'date-time') return '2026-01-01T00:00:00.000Z';
            if (node.format === 'date') return '2026-01-01';
            let text = `mock ${hint}`;
            if (node.minLength && text.length < node.minLength) text = text.padEnd(node.minLength, '.');
            if (node.maxLength && text.length > node.maxLength) text = text.slice(0, node.maxLength);
            return text;
        }
    }
}

/**
 * Makes `value` fit the schema: fills missing required properties, replaces values of the wrong type,
 * drops keys the schema forbids (`additionalProperties: false`) and clamps enums.
 */
export function conformToSchema(value, schema, root = schema, depth = 0, hint = 'value') {
    const node = deref(schema, root);
    if (value === undefined || depth > 10) return synthesizeFromSchema(node, root, depth, hint);
    if ('const' in node) return node.const;
    if (Array.isArray(node.enum) && node.enum.length > 0 && !node.enum.includes(value)) return node.enum[0];
    const type = primaryType(node);
    const nullable = Array.isArray(node.type) && node.type.includes('null');
    if (value === null) return nullable || type === 'null' ? null : synthesizeFromSchema(node, root, depth, hint);
    switch (type) {
        case 'object': {
            if (typeof value !== 'object' || Array.isArray(value)) return synthesizeFromSchema(node, root, depth, hint);
            const result = {};
            const properties = node.properties ?? {};
            for (const [key, item] of Object.entries(value)) {
                if (key in properties) result[key] = conformToSchema(item, properties[key], root, depth + 1, key);
                else if (node.additionalProperties !== false) result[key] = item;
            }
            for (const key of node.required ?? []) {
                if (!(key in result)) result[key] = synthesizeFromSchema(properties[key] ?? {}, root, depth + 1, key);
            }
            return result;
        }
        case 'array': {
            if (!Array.isArray(value)) return synthesizeFromSchema(node, root, depth, hint);
            const items = value.map((item) => conformToSchema(item, node.items ?? {}, root, depth + 1, hint));
            while (items.length < (node.minItems ?? 0))
                items.push(synthesizeFromSchema(node.items ?? {}, root, depth + 1, hint));
            return node.maxItems !== undefined ? items.slice(0, node.maxItems) : items;
        }
        case 'integer':
            return Number.isInteger(value) ? value : synthesizeFromSchema(node, root, depth, hint);
        case 'number':
            return typeof value === 'number' ? value : synthesizeFromSchema(node, root, depth, hint);
        case 'boolean':
            return typeof value === 'boolean' ? value : false;
        case 'string':
            return typeof value === 'string' ? value : String(value);
        default:
            return value;
    }
}

// Example handlers for Maestro background tasks. The real schemas are defined by src/ (stage 2+); the
// filling rules above keep these replies valid even when the real schema differs.
registerSchema('maestro_ping', (ctx) => ({ ok: true, model: ctx.model, echo: ctx.lastUserText.slice(0, 120) }));
// A wiring check for Dramatis through MAESTRO_API (task `dramatis.ping`).
registerTask('dramatis.ping', (ctx) => ({ ok: true, task: 'dramatis.ping', echo: ctx.lastUserText.slice(0, 120) }));

/** The last `#N` / `[N]` message number of the request (revision and living canon number their messages). */
function lastMessageIndex(text) {
    const numbers = [...String(text ?? '').matchAll(/(?:^|\n)(?:#|\[)(\d+)\]?\s/g)].map((match) => Number(match[1]));
    return numbers.length ? Math.max(...numbers) : 0;
}

// Revision «сюжет → канон» (src/domain/revision-prompt.ts): the value keeps its English/tag format, `russian` is the
// sentence the user's Inbox card shows (plan-2 §3).
registerSchema('maestro_revision', (ctx) => {
    const [a = DEFAULT_NAMES[0], b = DEFAULT_NAMES[1]] = ctx.names;
    const sourceMessage = lastMessageIndex(ctx.lastUserText);
    return {
        changes: [
            {
                class: 'known',
                entity: a,
                target: 'canon.fact',
                field: '',
                value: `${a} now openly sides with ${ctx.userName}.`,
                russian: `${a} теперь открыто на стороне ${ctx.userName}.`,
                before: '',
                evidence: `${a} открыто встаёт на сторону ${ctx.userName}.`,
                sourceMessage,
                confidence: 0.85,
            },
            {
                class: 'new',
                entity: 'Башня Звёздочётов Ориса',
                target: 'canon.fact',
                field: '',
                value: "An old stargazers' tower stands above the roofs of the Harbour.",
                russian: 'Над крышами Гавани стоит старая башня звездочётов.',
                before: '',
                evidence: `${b} упоминает башню впервые.`,
                sourceMessage,
                confidence: 0.8,
            },
        ],
    };
});

// Living canon batch extraction (src/domain/living-extract.ts, schema name 'living_canon'): English canon texts for
// the provisional facts it was sent, each with a short Russian sentence for the user's cards and notices.
registerSchema('living_canon', (ctx) => {
    const provisional = [...String(ctx.lastUserText ?? '').matchAll(/uid (\d+): ([^\n(]+?) \((\w+)\)/g)].map(
        (match) => ({
            uid: Number(match[1]),
            name: match[2].trim(),
            english: '',
            type: match[3],
            // English only: the canon text is checked for Latin script (the Russian name stays in the keys).
            text: `A ${match[3]} the narrator introduced recently; the people of the story know it well.`,
            russian: `${match[2].trim()} — то, что появилось в истории недавно.`,
            duplicateOf: '',
        }),
    );
    return { provisional, facts: [] };
});

registerSchema('maestro_backstage', (ctx) => ({
    events: [
        {
            who: ctx.names[0] ?? DEFAULT_NAMES[0],
            what: 'Тайно встречается с представителем гильдии',
            where: ctx.location ?? DEFAULT_LOCATION,
        },
    ],
}));

// NAI Studio asks the main API for visual passports of DES characters when a chat loads.
registerSchema('nai_passports', (ctx) => {
    const name = /Character:\s*([^\n]+)/.exec(ctx.lastUserText)?.[1]?.trim() || ctx.names[0] || DEFAULT_NAMES[0];
    const female = guessFemale(name);
    return {
        passports: [
            {
                kind: 'character',
                name,
                aliases: [],
                base: female ? '1girl, human, adult' : '1boy, human, adult',
                hair: 'dark hair, long hair',
                eyes: 'grey eyes',
                body: 'slender',
                skin: 'fair skin',
                clothing: 'dark cloak, travel clothes',
                accessories: 'leather belt',
                outfits: [],
                nsfw: '',
                negative: '',
            },
        ],
    };
});

// The wardrobe asks what the user's character wears: `[mock:wear:phrase]` in the chat is the answer, else null.
registerSchema('wardrobe_persona', (ctx) => ({ wearing: ctx.markers?.get('wear') || null }));

// The prompt audit (M38, src/domain/prompt-audit-ai.ts) sends a map of instructions (`[I1] owner · role…`, then the
// text between `<<<` and `>>>` lines): the answer is one conflict between the first two instructions, quoting the
// first sentence of each exactly, with an edit fix on the first one (none when the map has fewer than two).
registerSchema('maestro_prompt_audit', (ctx) => {
    const blocks = [...String(ctx.lastUserText ?? '').matchAll(/\[(I\d+)\][^\n]*\n<<<\n([\s\S]*?)\n>>>/g)];
    if (blocks.length < 2) return { conflicts: [] };
    const quote = (text) => {
        const body = text.replace(/^\s*<[^>\n]+>\s*/, '');
        return (/[^.!?\n]+[.!?]?/.exec(body)?.[0] ?? body).trim().slice(0, 160);
    };
    const [first, second] = blocks;
    const a = quote(first[2]);
    const b = quote(second[2]);
    return {
        conflicts: [
            {
                severity: 'medium',
                a: { owner: 'mock', ref: first[1], quote: a },
                b: { owner: 'mock', ref: second[1], quote: b },
                why: 'Эти две инструкции спорят друг с другом (ответ заглушки).',
                risk_for_model: '',
                fix: { side: 'a', kind: 'edit', target: first[1], after_text: `${a} (mock fix)`, scope_hint: 'global' },
            },
        ],
    };
});

// The English of a mechanic for the model (src/features/mechanics/translate.ts, schema 'maestro_mechanics_translate'):
// the request's items come back with an "EN: " prefix (Cyrillic kept: a test sees what was translated).
registerSchema('maestro_mechanics_translate', (ctx) => {
    let items;
    try {
        const parsed = JSON.parse(String(ctx.lastUserText ?? '{}'));
        items = Array.isArray(parsed?.items) ? parsed.items : [];
    } catch {
        items = [];
    }
    return {
        items: items
            .filter((item) => item && typeof item.key === 'string')
            .map((item) => ({ key: item.key, text: `EN: ${String(item.text ?? '')}` })),
    };
});

// The mechanics background parse (src/domain/mechanics-extract.ts, schema 'maestro_mechanics_extract'): the marker
// `[mock:mechextract:Кай.Mana=-10; Кай.Mood=warm; Кай.status+=poisoned 3 turns; Кай.status-=blessed;
// Кай.items+=rope 2; Кай.items-=coin 5]` in the reply it reads (a story turn with that marker repeats it on its last
// line). Statuses and items are dropped when the request's schema has no room for them.
registerSchema('maestro_mechanics_extract', (ctx) => {
    const changes = [];
    const statuses = [];
    const items = [];
    for (const raw of String(ctx.markers?.get('mechextract') ?? '').split(';')) {
        const match = /^\s*([^.=+-]+?)\.([^=+-]+?)\s*(\+=|-=|=)\s*(.+?)\s*$/.exec(raw);
        if (!match) continue;
        const [, holder, attribute, op, value] = match;
        const reason = 'mock';
        const key = attribute.trim().toLowerCase();
        if (key === 'status' || key === 'statuses') {
            const duration = /\s(\d+\s*\S+)$/.exec(value);
            const name = duration ? value.slice(0, duration.index).trim() : value;
            statuses.push({ holder, name, add: op !== '-=', duration: duration ? duration[1] : '', reason });
        } else if (key === 'items' || key === 'item') {
            const qty = /\s(\d+)$/.exec(value);
            const name = qty ? value.slice(0, qty.index).trim() : value;
            const count = qty ? Number(qty[1]) : 1;
            items.push({ holder, name, qty: op === '-=' ? -count : count, reason });
        } else if (/^[+-]?\d+(?:\.\d+)?$/.test(value) && (op !== '=' || /^[+-]/.test(value))) {
            const number = Number(value);
            changes.push({ holder, attribute, value: '', delta: op === '-=' ? -number : number, reason });
        } else {
            changes.push({ holder, attribute, value, delta: null, reason });
        }
    }
    return { changes, statuses, items };
});

registerTool('search_lore', (ctx) => ({ query: ctx.names[0] ?? DEFAULT_LOCATION, limit: 5 }));

// Scenario preparation (src/domain/prepare-extract.ts, schema 'maestro_prepare'): a plan read from the sources of the
// request. The card part: characters from «- Имя — описание» lines, places from «…» quotes, a house as a faction, a
// secret, the start time, a mechanic with a starting value and the direction. Every starting scene in the part
// («Starting scene — greeting N»): one entry of `scenes` — its place (a short «…» quote, else the archive or the
// harbour it names), its time of day, the cast it names, what they wear (a jacket, a robe or a cloak) and the type of
// its first scene. A book part: one place, faction, tradition or item per entry («[S2] Book · Title» with its Russian
// key).
// prettier-ignore
const PREP_TRANSLIT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function translit(name) {
    return [...String(name)]
        .map((char) => {
            const lower = char.toLowerCase();
            const latin = PREP_TRANSLIT[lower];
            if (latin === undefined) return char;
            return char === lower ? latin : latin.charAt(0).toUpperCase() + latin.slice(1);
        })
        .join('');
}

/** `[S1] Label\ntext` blocks of the request's <sources>. */
export function prepareSources(text) {
    const body = /<sources>\n([\s\S]*?)\n<\/sources>/.exec(String(text ?? ''))?.[1] ?? '';
    const out = [];
    for (const block of body.split(/\n(?=\[S\d+\] )/)) {
        const match = /^\[(S\d+)\] ([^\n]*)\n?([\s\S]*)$/.exec(block.trim());
        if (match) out.push({ ref: match[1], label: match[2], text: match[3] });
    }
    return out;
}

const PREP_PLACE_WORDS =
    /tavern|harbou?r|market|fort|fens?\b|pass\b|lighthouse|hall\b|monastery|hut\b|archive|coast|reaches/i;
const PREP_FACTION_WORDS = /\bhouse\b|order\b|guild|brotherhood|council|watch\b|smugglers|cult\b/i;
const PREP_TRADITION_WORDS = /festival|oath|tradition|custom|leave bread|spirits/i;
/** What the cast of a starting scene wears: the first garment its text names. */
const PREP_CLOTHES = [
    [/куртк/i, 'a quilted watch jacket'],
    [/мантии|мантия/i, "an archivist's robe"],
    [/плащ/i, 'a dark green cloak'],
];
const PREP_TIMES = [
    [/ноч/i, 'ночь', 'night'],
    [/рассвет/i, 'рассвет', 'dawn'],
    [/дожд|вечер/i, 'вечер', 'evening'],
];

/** One `scenes` entry of the mock for a starting scene of the request. */
function prepareScene(start, cast, persona, top) {
    const greeting = Number(/greeting (\d+)/.exec(start.label)?.[1] ?? 0);
    const text = start.text;
    const quoted = [...text.matchAll(/«([^»\n]{3,40})»/g)]
        .map((match) => match[1])
        .find((name) => /^[А-ЯЁ]/.test(name));
    const place =
        quoted ??
        (/архив/i.test(text) ? 'Архив гильдии картографов' : /гаван|причал/i.test(text) ? 'Серебряная Гавань' : top);
    const [, time, timeEnglish] = PREP_TIMES.find(([pattern]) => pattern.test(text)) ?? [null, 'утро', 'morning'];
    const present = cast.filter((name) => text.includes(name.slice(0, 4)));
    const wearing = PREP_CLOTHES.find(([pattern]) => pattern.test(text))?.[1] ?? '';
    const who = present.map((name) => translit(name)).join(' and ') || 'nobody yet';
    return {
        greeting,
        place,
        date: 'День 1',
        time,
        present,
        situation: `${persona} meets ${who} at ${translit(place)} at ${timeEnglish}.`,
        situation_ru: `${place}, ${time}: ${present.join(' и ') || 'пока никого'} — так начинается история.`,
        outfits: wearing ? present.map((name) => ({ name, wearing })) : [],
        firstScene: time === 'ночь' ? 'drama' : time === 'рассвет' ? 'exploration' : 'dialogue',
    };
}

registerSchema('maestro_prepare', (ctx) => {
    const request = ctx.lastUserText;
    const persona = /The player's character: ([^.\n]+)\./.exec(request)?.[1]?.trim() || ctx.userName;
    const sources = prepareSources(request);
    const empty = {
        characters: [],
        places: [],
        factions: [],
        items: [],
        traditions: [],
        promises: [],
        secrets: [],
        mechanics: [],
    };
    const blank = (fields) => ({ ...Object.fromEntries(fields.map((field) => [field, ''])), russian: '', sources: [] });
    const result = {
        ...empty,
        world: { ...blank(['name', 'english', 'setting', 'era', 'tone', 'laws', 'customs']), forms: [] },
        time: blank(['date', 'time', 'calendar']),
        scenes: [],
        direction: blank(['genre', 'pacing', 'firstScene', 'notes']),
    };
    const card = sources.filter((source) => !source.label.includes(' · '));
    const starts = card.filter((source) => /^Starting scene/.test(source.label));
    const fields = card.filter((source) => !starts.includes(source));
    // The cast as the card lists it (its description, or the <context> summary of a part without it).
    const cast = [...new Set([...request.matchAll(/^- ([А-ЯЁA-Z][\p{L}-]+) — /gmu)].map((match) => match[1]))];
    const city = /Серебрян\S+ Гаван\S+/.test(request) ? 'Серебряная Гавань' : '';
    if (fields.length) {
        const all = card.map((source) => source.text).join('\n');
        const refs = card.map((source) => source.ref);
        const greeting = starts[0];
        for (const match of all.matchAll(/^- ([А-ЯЁA-Z][\p{L}-]+) — ([^\n]+)$/gmu)) {
            const name = match[1];
            const english = translit(name);
            result.characters.push({
                name,
                english,
                forms: [],
                role: `${english} is one of the people of the story.`,
                appearance: `${english} looks the part of the role the story gives.`,
                personality: `${english} acts as the card describes.`,
                speech: 'Speaks plainly.',
                relations: [{ to: persona, relation: `${english} has just met ${persona}.` }],
                outfit: greeting?.text.includes(name.slice(0, 4)) ? 'a dark green cloak' : '',
                present: !!greeting?.text.includes(name.slice(0, 4)),
                persona: false,
                russian: match[2].trim().slice(0, 150),
                sources: refs.slice(0, 1),
            });
        }
        const quoted = [...all.matchAll(/«([^»\n]{3,40})»/g)].map((match) => match[1]);
        const places = [...new Set(quoted)].filter((name) => /^[А-ЯЁ]/.test(name)).slice(0, 2);
        const top = /Серебрян\S+ Гаван\S+/.exec(all)?.[0] ? 'Серебряная Гавань' : '';
        if (top) {
            result.places.push({
                name: top,
                english: 'Silver Harbor',
                forms: ['Гавань', 'Серебряной Гавани'],
                parent: '',
                kind: 'port city',
                description: 'A free port on the cold northern coast.',
                state: '',
                russian: 'Вольный порт на холодном северном побережье.',
                sources: refs.slice(0, 1),
            });
        }
        for (const name of places) {
            result.places.push({
                name,
                english: translit(name),
                forms: [],
                parent: top,
                kind: 'tavern',
                description: `${translit(name)} is where the story begins.`,
                state: 'Rain drums on the shutters.',
                russian: `«${name}» — место, где начинается история.`,
                sources: refs.slice(0, 1),
            });
        }
        const house = /торгов\S+ дом\S* (\p{Lu}\p{L}+)/u.exec(all)?.[1];
        if (house) {
            result.factions.push({
                name: `Торговый дом ${house}`,
                english: `House ${translit(house)}`,
                forms: [house],
                leader: '',
                goals: 'Keep its seat on the council.',
                description: 'An old merchant family.',
                russian: `Старый торговый дом ${house}, держится за место в совете.`,
                sources: refs.slice(0, 1),
            });
        }
        const first = result.characters[0]?.name ?? DEFAULT_NAMES[0];
        result.secrets.push({
            text: `${translit(first)} knows more about the missing cargo than she says.`,
            about: first,
            knownBy: [first],
            hiddenFrom: [persona],
            russian: `${first} знает о пропавшем грузе больше, чем говорит.`,
            sources: refs.slice(0, 1),
        });
        result.time = {
            date: 'День 1',
            time: /дожд|вечер/i.test(all) ? 'вечер' : 'утро',
            calendar: '',
            russian: 'История начинается в первый день, вечером.',
            sources: refs.slice(0, 1),
        };
        result.mechanics.push({
            name: 'Доверие',
            english: 'Trust',
            summary: 'How much the people of the story trust the player.',
            rules: 'Trust grows with kept promises and falls with lies.',
            template: '',
            holders: 'characters',
            holderNames: [],
            attributes: [
                {
                    name: 'Доверие',
                    english: 'Trust',
                    kind: 'number',
                    min: 0,
                    max: 100,
                    initial: '50',
                    levels: [],
                    options: [],
                },
            ],
            initial: [{ holder: first, attribute: 'Trust', value: '40' }],
            russian: 'Насколько персонажи доверяют герою.',
            sources: refs.slice(0, 1),
        });
        result.direction = {
            genre: 'Mystery',
            pacing: 'Measured, with room for conversation.',
            firstScene: 'dialogue',
            notes: 'Open with talk, keep the threat off screen.',
            russian: 'Детектив в неспешном темпе, начинается с разговора.',
            sources: refs.slice(0, 1),
        };
        const world = /в мире ([\p{L}\s]+?)[.,]/u.exec(all)?.[1]?.trim();
        if (world) {
            result.world = {
                name: world,
                english: translit(world),
                forms: [],
                setting: 'A cold northern coast of free ports and fens.',
                era: 'Age of sail',
                tone: 'Grim and wet, with warm taverns.',
                laws: 'Little magic; the sea rules.',
                customs: 'Oaths are sworn on salt.',
                russian: 'Холодное северное побережье вольных портов и топей.',
                sources: refs.slice(0, 1),
            };
        }
    }
    for (const start of starts) result.scenes.push(prepareScene(start, cast, persona, city));
    for (const source of sources.filter((item) => item.label.includes(' · '))) {
        const title = source.label.split(' · ').slice(1).join(' · ').trim();
        const russian = /Keys: ([^\n]*)/
            .exec(source.text)?.[1]
            ?.split(',')
            .map((key) => key.trim())
            .find((key) => /[А-яЁё]/.test(key));
        const name = russian || title;
        const base = {
            name,
            english: title,
            forms: [],
            russian: `«${name}» — из книги мира этой истории.`,
            sources: [source.ref],
        };
        const sentence =
            source.text
                .split('\n')
                .find((line) => !line.startsWith('Keys:'))
                ?.split('. ')[0] ?? title;
        if (PREP_FACTION_WORDS.test(title))
            result.factions.push({ ...base, leader: '', goals: '', description: `${sentence}.` });
        else if (PREP_PLACE_WORDS.test(`${title} ${sentence}`))
            result.places.push({ ...base, parent: '', kind: '', description: `${sentence}.`, state: '' });
        else if (PREP_TRADITION_WORDS.test(`${title} ${sentence}`))
            result.traditions.push({ ...base, when: '', practice: `${sentence}.`, meaning: '' });
        else result.items.push({ ...base, owner: '', description: `${sentence}.` });
    }
    return result;
});

/* ------------------------------------------------------------------ reply builders */

/**
 * The key of a clothing field the DES tracker template asks for (Maestro adds «Одежда» / "Outfit" with the user's
 * consent), or null: real DES only has appearance and demeanor.
 */
export function outfitFieldOf(texts) {
    for (const text of texts) {
        for (const block of String(text ?? '').matchAll(/"details"\s*:\s*\{([^{}]*)\}/g)) {
            for (const key of block[1].matchAll(/"([^"\n]{1,40})"\s*:/g)) {
                if (/одежд|наряд|outfit|cloth|attire/i.test(key[1])) return key[1];
            }
        }
    }
    return null;
}

function trackerObject(ctx, rng, lang) {
    const text = TEXT[lang];
    const outfitKey = outfitFieldOf(ctx.texts ?? []);
    // [mock:outfit:Имя=наряд] (or just [mock:outfit:наряд] for the first character) dresses a character: the clothes
    // go into the appearance text like real DES writes them, and into the clothing field when the template has one;
    // a named character who is not in the scene joins it.
    const outfitArg = ctx.markers?.get('outfit') ?? '';
    const [outfitWho, outfitWhat] = outfitArg.includes('=')
        ? outfitArg.split('=', 2).map((part) => part.trim())
        : ['', outfitArg.trim()];
    // [mock:stat:Имя=Mana:40,Health:90] gives that character DES stats (the first character without a name).
    const statArg = ctx.markers?.get('stat') ?? '';
    const [statWho, statList] = statArg.includes('=')
        ? statArg.split('=', 2).map((part) => part.trim())
        : ['', statArg];
    const stats = statList
        .split(',')
        .map((item) => item.split(':').map((part) => part.trim()))
        .filter(([name, value]) => name && value !== undefined && value !== '')
        .map(([name, value]) => ({ name, value: Number.isFinite(Number(value)) ? Number(value) : value }));
    const known = (ctx.names.length ? ctx.names : DEFAULT_NAMES).slice(0, 3);
    const joining = [...new Set([outfitWho, statWho].filter((name) => name && !known.includes(name)))];
    const names = [...joining, ...known].slice(0, Math.max(3, joining.length));
    const outfitIndex = outfitWho ? names.indexOf(outfitWho) : 0;
    const statIndex = statWho ? names.indexOf(statWho) : 0;
    const weather = pick(rng, WEATHER);
    const start = ctx.lastTime ?? { h: 18, m: 0 };
    const startMinutes = start.h * 60 + start.m;
    const endMinutes = startMinutes + 10 + Math.floor(rng() * 4) * 5;
    const hhmm = (minutes) => {
        const m = ((minutes % 1440) + 1440) % 1440;
        return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    };
    const statuses = ['Ally', 'Friend', 'Neutral'];
    return {
        quests: {
            main: { title: pick(rng, text.quests) },
            optional: shuffled(rng, text.optional)
                .slice(0, 2)
                .map((title) => ({ title })),
        },
        infoBox: {
            date: { value: ctx.lastDate ?? text.date },
            time: { start: hhmm(startMinutes), end: hhmm(endMinutes) },
            location: { value: ctx.location ?? (lang === 'en' ? 'Silver Harbor' : DEFAULT_LOCATION) },
            weather: { emoji: weather.emoji, forecast: weather.forecast },
            temperature: { value: 6 + Math.floor(rng() * 10), unit: 'C' },
            recentEvents: [pick(rng, text.events)],
        },
        characters: names.map((name, i) => {
            const look = pick(rng, text.appearance);
            const dressed = outfitWhat && i === outfitIndex;
            return {
                name,
                emoji: ['🌹', '⚔️', '⚗️', '⚓', '🗺️'][i % 5],
                details: {
                    appearance: `${look.look}, ${dressed ? outfitWhat : look.wear}`,
                    demeanor: pick(rng, text.demeanor),
                    ...(outfitKey ? { [outfitKey]: dressed ? outfitWhat : look.outfit } : {}),
                },
                ...(stats.length && i === statIndex ? { stats } : {}),
                relationship: { status: pick(rng, statuses) },
                thoughts: { content: fill(pick(rng, text.thoughts), { U: ctx.userName }) },
            };
        }),
    };
}

/** The DES together-mode tracker block that opens a reply. */
export function trackerBlock(ctx, rng, lang = 'ru') {
    return '```json\n' + JSON.stringify(trackerObject(ctx, rng, lang), null, 2) + '\n```';
}

function prose(ctx, rng, lang, { user = false, invent = false } = {}) {
    const text = TEXT[lang];
    const names = ctx.names.length ? ctx.names : DEFAULT_NAMES;
    const place = ctx.location ?? (lang === 'en' ? 'Silver Harbor' : DEFAULT_LOCATION);
    const weather = pick(rng, WEATHER)[lang];
    const vars = { P: place, W: weather, U: ctx.userName };
    const count = 2 + Math.floor(rng() * 3);
    const paragraphs = [];
    const actors = shuffled(rng, names);
    // Draw without replacement so one reply never repeats a sentence.
    const deck = (list) => {
        const cards = shuffled(rng, list);
        let i = 0;
        return () => cards[i++ % cards.length];
    };
    const action = deck(text.actions);
    const line = deck(text.lines);
    const closer = deck(text.closers);
    for (let i = 0; i < count; i++) {
        const x = actors[i % actors.length];
        const parts = [];
        if (i === 0) parts.push(fill(pick(rng, text.openers), vars));
        parts.push(fill(action(), { ...vars, X: x }));
        parts.push(fill(line(), { ...vars, X: actors[(i + 1) % actors.length] }));
        if (rng() < 0.6) parts.push(closer());
        paragraphs.push(parts.join(' '));
    }
    if (invent) {
        const haystack = ctx.texts.join('\n').toLowerCase();
        const fresh = text.invent.filter(([term]) => !haystack.includes(term.toLowerCase()));
        const [term, template] = pick(rng, fresh.length ? fresh : text.invent);
        paragraphs.splice(1, 0, fill(template, { ...vars, T: term, X: actors[0] }));
    }
    if (user) paragraphs.push(fill(pick(rng, text.user), vars));
    return paragraphs.join('\n\n');
}

function guessFemale(name) {
    if (FEMALE_NAMES.has(name)) return true;
    if (PROFILES[name]) return false;
    return /[ая]$/i.test(name);
}

/** A BunnyMo-style !fullsheet reply: Russian prose, English machine layer, closing <BunnymoTags>. */
export function sheetText(name, ctx) {
    const profile = PROFILES[name] ?? {
        title: 'Странник',
        mbti: 'INTJ-H',
        dere: 'KUUDERE',
        age: 30,
        hair: 'DARK_BROWN',
    };
    const female = guessFemale(name);
    const sections = [
        [
            '📋 **Core Identity**',
            `**Name:** ${name}\nCharacter Title: ${profile.title}\n- **Возраст:** ${profile.age}\n- **Роль в истории:** ${profile.title.toLowerCase()}, давний знакомый ${ctx.userName}`,
        ],
        [
            '🎭 **Genre & Archetypes**',
            '- **Жанр:** тёмное приключенческое фэнтези с элементами детектива\n- **Архетип:** хранитель чужих тайн',
        ],
        [
            '💗 **Dere Type**',
            `- **Основной тип:** ${profile.dere.toLowerCase()} — тепло проявляется поступками, а не словами`,
        ],
        ['🧠 **MBTI**', `- **Тип:** ${profile.mbti.replace(/-.*/, '')} — опора на план и долгую память на обиды`],
        ['🔗 **Attachment**', '- **Стиль:** избегающий; доверие нужно заслужить делом'],
        ['🗣️ **Linguistics**', '- **Речь:** коротко, по делу, с сухим юмором; на эмоциях переходит на шёпот'],
        [
            '🧬 **Species & Physique**',
            `- **Вид:** человек\n- **Телосложение:** жилистое, выносливое; волосы ${profile.hair.toLowerCase()}`,
        ],
        ['⚡ **Chemistry & Flirting**', '- **Флирт:** через насмешку и заботу о мелочах'],
        [
            '🛡️ **Boundaries & Conflict**',
            '- **Конфликт:** стратегический, сначала выжидает\n- **Границы:** жёсткие, но не глухие',
        ],
        ['🎲 **Decision Making**', '- **Решения:** взвешивает риски, но в кризисе действует мгновенно'],
        ['🫂 **Comfort & Trust**', '- **Утешение:** тихая работа руками, горячий чай, разговор без свидетелей'],
        ['🎭 **Mask vs Reality**', '- **Маска:** невозмутимость\n- **Правда:** постоянная тревога за своих'],
        ['🍷 **Vices & Loyalty**', '- **Слабость:** бессонница и крепкий кофе\n- **Верность:** людям, а не титулам'],
        [
            '🏥 **Health & Conditions Profile**',
            '- **Состояние:** хроническая бессонница после осады\n- **Как справляется:** работа до изнеможения',
        ],
    ];
    const lines = ['Ставлю историю на паузу — вот лист персонажа.', ''];
    sections.forEach(([title, body], i) => {
        lines.push(`## SECTION ${i + 1}/${sections.length}: ${title}`, body, '');
    });
    lines.push('---', '', '# 🎯**TAG SYNTHESIS**🎯', '');
    lines.push(
        `<BunnymoTags><Name:${name}>, <GENRE:FANTASY> <PHYSICAL> <SPECIES:HUMAN>, <GENDER:${female ? 'FEMALE' : 'MALE'}>, ` +
            `<AGE:${profile.age}>, <HAIRCOLOR:${profile.hair}>, <EYECOLOR:GREY>, <SKINCOLOR:FAIR>, <FONT:#8E44AD>, ` +
            `<BUILD:ATHLETIC>, <STYLE:PRACTICAL>, </PHYSICAL> <PERSONALITY><Dere:${profile.dere}>, <${profile.mbti}>, ` +
            '<TRAIT:STOIC>, <TRAIT:LOYAL>, <TRAIT:OBSERVANT>, <ATTACHMENT:AVOIDANT>, <CONFLICT:STRATEGIC>, ' +
            '<BOUNDARIES:RIGID>, <FLIRTING:TEASING>, <DECISION:CALCULATED>, <COMFORT:ACTS_OF_SERVICE>, <VICE:CAFFEINE>, ' +
            '<LOYALTY:PERSONAL>, <TRUST:EARNED>, <MASK:STOIC>, </PERSONALITY> <NSFW><ORIENTATION:HETEROSEXUAL>, ' +
            '<POWER:SWITCH>, <CHEMISTRY:SLOW_BURN>, <JEALOUSY:QUIET>, <TRAUMA:SIEGE>, </NSFW> <HEALTH><BSM:INSOMNIA>, ' +
            '<CONDITION:NONE>, <REC:COFFEE>, </HEALTH></BunnymoTags>',
    );
    return lines.join('\n');
}

function cutMidSentence(text, rng) {
    if (text.length < 40) return text.slice(0, Math.max(1, Math.floor(text.length / 2)));
    // Cut inside the prose, after a leading tracker block when there is one.
    const open = text.indexOf('```json');
    const close = open >= 0 ? text.indexOf('\n```', open + 7) : -1;
    const from = open >= 0 && open < 200 && close > 0 ? close + 4 : 0;
    let at = from + Math.floor((text.length - from) * (0.5 + rng() * 0.3));
    // Land inside a word so the cut is visibly mid-sentence.
    while (at < text.length - 2 && !(/\p{L}/u.test(text[at - 1] ?? '') && /\p{L}/u.test(text[at] ?? ''))) at++;
    return text.slice(0, at);
}

const BOS_PREFIX =
    '<｜begin▁of▁sentence｜>```python\nimport json\nstate = json.loads(tracker)\nprint(state["infoBox"])\n```\n';

function toolCallFor(ctx, rng, n) {
    const tools = ctx.tools.filter((t) => t?.type === 'function' && t.function?.name);
    if (tools.length === 0) return null;
    // [mock:tool:name] or [mock:tool:name={"json":"args"}] (the given arguments are used as they are).
    const [askedName, askedArgs] = (ctx.markers.get('tool') ?? '').split(/=(.*)/s);
    let given;
    try {
        given = askedArgs ? JSON.parse(askedArgs) : null;
    } catch {
        given = null;
    }
    const forced = typeof ctx.toolChoice === 'object' ? ctx.toolChoice?.function?.name : null;
    // A name in the user's own message wins over names a system prompt lists.
    const mentionedIn = (text) => tools.find((t) => text.includes(t.function.name))?.function.name;
    const mentioned = mentionedIn(ctx.lastUserText ?? '') || mentionedIn(ctx.trailingText);
    const name = forced || askedName || mentioned || tools[0].function.name;
    const tool = tools.find((t) => t.function.name === name) ?? tools[0];
    const parameters = tool.function.parameters ?? { type: 'object', properties: {} };
    const handler = toolHandlers.get(tool.function.name);
    const args = given ?? conformToSchema(handler ? handler(ctx, rng) : {}, parameters);
    return {
        id: `call_mock_${n}_${hashString(tool.function.name).toString(16)}`,
        type: 'function',
        function: { name: tool.function.name, arguments: JSON.stringify(args) },
    };
}

function wantsTool(ctx) {
    if (ctx.tools.length === 0) return false;
    if (ctx.markers.has('tool')) return true;
    if (ctx.toolChoice === 'required') return true;
    if (typeof ctx.toolChoice === 'object' && ctx.toolChoice?.function?.name) return true;
    if (ctx.toolChoice === 'none') return false;
    return ctx.tools.some((t) => t?.function?.name && ctx.trailingText.includes(t.function.name));
}

/**
 * Builds the reply for an analysed request.
 * @returns {{ scenario: string, content: string, finishReason: string, toolCalls: any[] | null, reasoning: string | null }}
 */
export function buildReply(ctx, n = 0) {
    const rng = makeRng(ctx.seed);
    const m = ctx.markers;
    const lang = m.has('english') ? 'en' : 'ru';
    const flags = FLAG_MARKERS.filter((f) => m.has(f));
    const label = (kind) => [kind, ...flags].join('+');
    const reasoning = m.has('reasoning')
        ? lang === 'en'
            ? 'The user wants the scene to continue. Keep the tracker first, then the prose.'
            : 'Пользователь ждёт продолжения сцены. Сначала трекер, затем проза.'
        : null;

    // Tool loop: a tool result in the last message gets a closing answer.
    if (ctx.tools.length > 0 && ctx.lastRole === 'tool') {
        const result = messageText(ctx.messages.at(-1)).slice(0, 200);
        return {
            scenario: label('tool-result'),
            content: `Готово. Инструмент вернул: ${result}`,
            finishReason: 'stop',
            toolCalls: null,
            reasoning,
        };
    }
    if (wantsTool(ctx)) {
        const call = toolCallFor(ctx, rng, n);
        if (call)
            return {
                scenario: label('tool-call'),
                content: '',
                finishReason: 'tool_calls',
                toolCalls: [call],
                reasoning,
            };
    }

    if (ctx.schema || ctx.jsonObject) {
        if (m.has('refusal')) {
            return {
                scenario: label('schema-refusal'),
                content: TEXT[lang].refusal[0],
                finishReason: 'stop',
                toolCalls: null,
                reasoning,
            };
        }
        let handler = ctx.schema ? schemaHandlers.get(ctx.schema.name) : null;
        let dramatis = '';
        if (!handler && ctx.schema && isDramatisSchema(ctx.schema.name)) {
            const found = dramatisHandler(ctx.schema.name);
            handler = found.handler;
            dramatis = found.how;
        }
        const raw = handler ? handler(ctx, rng) : {};
        const value = ctx.schema ? conformToSchema(raw, ctx.schema.schema) : raw;
        let content = JSON.stringify(value, null, 2);
        let finishReason = 'stop';
        if (m.has('fenced')) content = '```json\n' + content + '\n```';
        if (m.has('badjson')) content = content.slice(0, Math.max(2, Math.floor(content.length * 0.6))) + ' …';
        if (m.has('truncate')) {
            content = content.slice(0, Math.max(2, Math.floor(content.length * 0.6)));
            finishReason = 'length';
        }
        const kind = ctx.schema
            ? `schema:${ctx.schema.name}${dramatis ? `(${dramatis})` : handler ? '' : '(walker)'}`
            : 'json-object';
        return { scenario: label(kind), content, finishReason, toolCalls: null, reasoning };
    }

    let kind = 'story';
    let content;
    if (ctx.summary) {
        kind = 'summary';
        const names = ctx.names.length ? ctx.names : DEFAULT_NAMES;
        content = fill(pick(rng, TEXT[lang].summary), { A: names[0], B: names[1] ?? names[0], U: ctx.userName });
    } else if (m.has('refusal')) {
        kind = 'refusal';
        content = TEXT[lang].refusal.join('\n\n');
    } else if (m.has('repeat') && ctx.lastAssistantText) {
        kind = 'repeat';
        content = ctx.lastAssistantText;
    } else if (ctx.wantsSheet) {
        kind = 'sheet';
        const target = ctx.sheetTarget || ctx.names[0] || DEFAULT_NAMES[1];
        // The defect Maestro has to repair: the sheet is followed by an unrequested scene and a tracker.
        content = [sheetText(target, ctx), prose(ctx, rng, lang), m.has('nojson') ? '' : trackerBlock(ctx, rng, lang)]
            .filter(Boolean)
            .join('\n\n');
    } else {
        const body = prose(ctx, rng, lang, { user: m.has('user'), invent: m.has('invent') });
        content = m.has('nojson') ? body : `${trackerBlock(ctx, rng, lang)}\n\n${body}`;
    }

    // [mock:mechblock:Кай.Mana: -10; Кай.Schools += fire] ends the reply with a mechanics service block (M25).
    if (kind === 'story' && m.get('mechblock')) {
        const lines = m
            .get('mechblock')
            .split(';')
            .map((line) => line.trim())
            .filter(Boolean);
        content += ['', '', '<mechanics>', ...lines, '</mechanics>'].join('\n');
    }
    // [mock:mechextract:…] in a story turn: the reply repeats the marker on its last line, so the background parse of
    // that reply (which only sees the reply) finds it.
    if (kind === 'story' && m.get('mechextract')) content += `\n\n[mock:mechextract:${m.get('mechextract')}]`;

    let finishReason = 'stop';
    if (m.has('bos')) content = BOS_PREFIX + content;
    if (m.has('truncate')) {
        content = cutMidSentence(content, rng);
        finishReason = 'length';
    }
    return { scenario: label(kind), content, finishReason, toolCalls: null, reasoning };
}
