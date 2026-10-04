// Curated phrase lists of the free reply checks (M12): English calques and clichés in Russian prose, English
// clichés («slop»), refusals and out-of-role notes, moralising, consent nagging, fade-to-black (§11: all of these
// are defects — Maestro never softens a story). Speech and action verbs for «the reply speaks for {{user}}».
// Kept in TypeScript (not JSON): they are regular expressions. Every pattern is anchored on word starts
// (`(?<![\p{L}\p{N}])` — `\b` does not see Cyrillic) and kept narrow: a wrong hit costs the user a badge or a
// swipe, a missed one only a judge call. Ideas from DES-RU's ROBOTIC_STEMS_RU and its language lock; no code shared.

export interface Phrase {
    id: string;
    re: RegExp;
}

/** A refusal / moralising / softening rule; weights differ in narration and inside dialogue (in-character lines). */
export interface ToneRule {
    id: string;
    kind: 'refusal' | 'moralizing' | 'softening';
    re: RegExp;
    narration: number;
    dialogue: number;
}

/* ------------------------------------------------------------------ language: calques and clichés */

/** English calques in Russian prose (literal translations that a native writer would not use). */
export const RU_CALQUES: readonly Phrase[] = [
    { id: 'makes-sense', re: /(?<![\p{L}\p{N}])(?:с)?дела(?:ет|ют|ло|ли|л|ла|ть)\s+(?:\p{L}+\s+)?смысл(?!\p{L})/iu },
    { id: 'end-of-the-day', re: /(?:^|[.!?…—]\s*)в\s+конце\s+дня\s*,/imu },
    {
        id: 'take-a-shower',
        re: /(?<![\p{L}\p{N}])(?:взял|взяла|взяли|взять|возьму|возьм[её]т|беру|бер[её]т)\s+душ(?!\p{L})/iu,
    },
    { id: 'make-a-decision', re: /(?<![\p{L}\p{N}])(?:с)?дела(?:ть|л|ла|ли|ет|ю)\s+(?:это\s+|такое\s+)?решени/iu },
    { id: 'make-a-difference', re: /(?<![\p{L}\p{N}])(?:с)?дела(?:ть|л|ла|ли|ет|ют)\s+(?:большую\s+|всю\s+)?разниц/iu },
    { id: 'oh-my-god', re: /(?<![\p{L}\p{N}])о,?\s+мой\s+бог(?!\p{L})/iu },
    { id: 'sounds-good', re: /(?<![\p{L}\p{N}])звучит\s+(?:как\s+(?:план|хорошая\s+идея)|хорошо)(?!\p{L})/iu },
    { id: 'my-bad', re: /(?<![\p{L}\p{N}])мой\s+плохой(?!\p{L})/iu },
    { id: 'good-luck-with-that', re: /(?<![\p{L}\p{N}])удачи\s+с\s+этим(?!\p{L})/iu },
    {
        id: 'testament-to',
        re: /(?<![\p{L}\p{N}])(?:является|был[аои]?|стал[аои]?|служит|служил[аои]?)\s+(?:живым\s+)?свидетельством(?!\p{L})/iu,
    },
    { id: 'let-me-know', re: /(?<![\p{L}\p{N}])дай(?:те)?\s+мне\s+знать(?!\p{L})/iu },
    { id: 'feel-free', re: /(?<![\p{L}\p{N}])не\s+стесняй(?:ся|тесь)\s+(?:спрашивать|обращаться|сказать|говорить)/iu },
    { id: 'it-is-what-it-is', re: /(?<![\p{L}\p{N}])это\s+то,?\s+что\s+(?:это\s+)?есть(?!\p{L})/iu },
    { id: 'couldnt-help-but', re: /(?<![\p{L}\p{N}])не\s+мог(?:ла|ли|у)?\s+помочь\s*,?\s+(?:но|кроме\s+как)\s+/iu },
];

/** Overused images of machine-written Russian prose (mostly translated English «slop»). */
export const RU_CLICHES: readonly Phrase[] = [
    {
        id: 'breath-holding',
        re: /(?:выдох|выпуст)\p{L}*[^.!?\n]{0,50}не\s+(?:знал|знала|подозревал|подозревала|замечал|замечала)[^.!?\n]{0,30}задерживал/iu,
    },
    {
        id: 'shivers-spine',
        re: /(?:мурашк\p{L}*|дрож\p{L}*|холодок)\s+(?:пробежал\p{L}*|побежал\p{L}*|прош[её]л|прошл\p{L}*)\s+(?:вниз\s+)?по\s+(?:е[её]\s+|его\s+|моей\s+|твоей\s+)?(?:спин|позвоночник|кож)/iu,
    },
    { id: 'above-a-whisper', re: /(?:чуть|едва|немногим|ненамного)\s+(?:громче|выше)\s+ш[её]пота/iu },
    {
        id: 'mischief-in-eyes',
        re: /озорн\p{L}*\s+(?:блеск|огон[её]к|искорк|искр)|в\s+(?:е[её]|его|их)\s+глазах\s+(?:плясал|заплясал|блеснул|мелькнул|вспыхнул)\p{L}*\s+(?:озорн|лукав|хитр|чертят|черт|искорк)/iu,
    },
    {
        id: 'lips-curled',
        re: /губ\p{L}*\s+(?:изогнул|растянул|скривил|дрогнул)\p{L}*\s+в\s+(?:ухмылк|усмешк|полуулыбк|кривой\s+улыбк)/iu,
    },
    {
        id: 'mix-of',
        re: /(?<![\p{L}\p{N}])смес\p{L}*\s+(?:страха|ужаса|желания|раздражения|возбуждения|удивления|восхищения|гнева|нежности|любопытства|тревоги|боли|веселья)\s+и\s+\p{L}+/iu,
    },
    {
        id: 'tapestry',
        re: /(?<![\p{L}\p{N}])гобелен\p{L}*\s+(?:из\s+)?(?:эмоций|чувств|звуков|запахов|жизни|судеб|ощущений)/iu,
    },
    { id: 'playing-with-fire', re: /(?<![\p{L}\p{N}])игра\p{L}*\s+с\s+огн[её]м/iu },
    { id: 'swallowed-hard', re: /(?<![\p{L}\p{N}])(?:тяжело|с\s+трудом)\s+сглотнул\p{L}*/iu },
    { id: 'electric-jolt', re: /электрическ\p{L}*\s+(?:разряд|ток|искр)\p{L}*\s+(?:пробежал|пронзил|прош)/iu },
    { id: 'world-narrowed', re: /(?<![\p{L}\p{N}])мир\s+(?:вокруг\s+)?(?:сузился|сжался|перестал\s+существовать)/iu },
    {
        id: 'voice-dripping',
        re: /голос\p{L}*[^.!?\n]{0,20}(?:сочил\p{L}*|пропитан\p{L}*)\s+(?:сарказм|яд|м[её]д|желани|похот)/iu,
    },
    { id: 'maybe-just-maybe', re: /может\s+быть,?\s+только\s+может\s+быть/iu },
];

/** English «slop» phrases (checked when the chat language is English). */
export const EN_CLICHES: readonly Phrase[] = [
    { id: 'testament-to', re: /\b(?:is|was|are|were|stands? as|serves? as|a)\s+(?:living\s+)?testament\s+to\b/i },
    {
        id: 'shivers-spine',
        re: /\b(?:shivers?|chills?)\s+(?:ran|run|runs|running|went|crawled|raced|shot|traveled|travelled)\s+(?:up\s+and\s+)?down\s+(?:her|his|my|your|their)\s+spine\b/i,
    },
    { id: 'above-a-whisper', re: /\bbarely\s+(?:above|more\s+than)\s+a\s+whisper\b/i },
    {
        id: 'breath-holding',
        re: /\bbreath\s+(?:she|he|i|they|you)\s+(?:didn't|did\s+not|hadn't)\s+(?:know|realize)\s+(?:she|he|i|they|you)\s+(?:was|were|had\s+been)\s+holding\b/i,
    },
    {
        id: 'mischief-in-eyes',
        re: /\b(?:eyes|gaze)\s+(?:sparkl|glint|twinkl|gleam|danc)\w*\s+with\s+(?:mischief|amusement|mirth)\b/i,
    },
    { id: 'mix-of', re: /\ba\s+mix(?:ture)?\s+of\s+\w+\s+and\s+\w+/i },
    { id: 'ministrations', re: /\bministrations\b/i },
    { id: 'tapestry', re: /\b(?:rich\s+)?tapestry\s+of\b/i },
    { id: 'audible-pop', re: /\baudible\s+pop\b/i },
    { id: 'maybe-just-maybe', re: /\bmaybe,?\s+just\s+maybe\b/i },
    { id: 'playing-with-fire', re: /\bplaying\s+with\s+fire\b/i },
    { id: 'couldnt-help-but', re: /\b(?:couldn't|could\s+not)\s+help\s+but\b/i },
    { id: 'voice-dripping', re: /\bvoice\s+(?:dripping|laced)\s+with\b/i },
    { id: 'electric-jolt', re: /\b(?:jolt|spark|bolt)s?\s+of\s+electricity\b/i },
    { id: 'world-narrowed', re: /\bthe\s+world\s+(?:narrowed|fell\s+away|faded\s+away)\b/i },
    { id: 'padded', re: /\bpadded\s+(?:over|across|into|towards?)\b/i },
    { id: 'orbs', re: /\b(?:emerald|sapphire|azure|cerulean|chocolate|amber|hazel)\s+orbs\b/i },
    { id: 'little-did', re: /\blittle\s+did\s+(?:she|he|they|i|you)\s+know\b/i },
    { id: 'felt-like-eternity', re: /\bfor\s+what\s+(?:felt|seemed)\s+like\s+(?:an\s+eternity|hours|forever)\b/i },
    { id: 'swallowed-hard', re: /\bswallow(?:ed|s)\s+hard\b/i },
    { id: 'air-thick', re: /\bthe\s+air\s+(?:was\s+|grew\s+|is\s+)?thick\s+with\b/i },
    { id: 'grand-scheme', re: /\bin\s+the\s+grand\s+scheme\s+of\s+things\b/i },
];

/* ------------------------------------------------------------------ refusal, moralising, softening */

// prettier-ignore
export const TONE_RULES: readonly ToneRule[] = [
    // Refusals (assistant voice). Inside dialogue a character may refuse something: weights drop there.
    { id: 'as-an-ai', kind: 'refusal', narration: 0.95, dialogue: 0.6,
        re: /\bas\s+an?\s+(?:ai|artificial\s+intelligence|(?:ai\s+)?language\s+model|llm|ai\s+assistant)\b/i },
    { id: 'as-an-ai-ru', kind: 'refusal', narration: 0.95, dialogue: 0.6,
        re: /(?<![\p{L}\p{N}])как\s+(?:ии|ai|языков\p{L}*\s+модель|искусственн\p{L}*\s+интеллект|ассистент)\s*,\s*я(?!\p{L})/iu },
    { id: 'cant-continue', kind: 'refusal', narration: 0.9, dialogue: 0.45,
        re: /\bI(?:'m|\s+am)?\s*(?:can(?:no|')t|cannot|won't|will\s+not|am\s+not\s+able\s+to|'m\s+not\s+able\s+to|am\s+unable\s+to|'m\s+unable\s+to|unable\s+to)\s+(?:continue|write|generate|create|produce|engage|participate|fulfill|comply|assist|provide|depict|describe|go\s+on)\b[^.!?\n]{0,60}?\b(?:roleplay|role-play|request|content|scenario|scene|narrative|story|prompt)\b/i },
    { id: 'cant-continue-ru', kind: 'refusal', narration: 0.9, dialogue: 0.45,
        re: /(?<![\p{L}\p{N}])(?:я\s+)?не\s+(?:могу|буду|стану|смогу)\s+(?:продолжить|продолжать|писать|написать|создать|создавать|генерировать|сгенерировать|описывать|описать|участвовать|выполнить)[^.!?\n]{0,60}?(?:ролев|запрос|контент|сцен|материал|текст|истори|сюжет)/iu },
    { id: 'cant-help-ru', kind: 'refusal', narration: 0.85, dialogue: 0.35,
        re: /(?<![\p{L}\p{N}])(?:я\s+)?не\s+могу\s+(?:с\s+этим\s+)?помочь\s+(?:с\s+)?(?:этим\s+)?(?:запрос|просьб)/iu },
    { id: 'policy', kind: 'refusal', narration: 0.9, dialogue: 0.7,
        re: /\b(?:content\s+(?:policy|policies|guidelines)|usage\s+(?:policy|policies)|community\s+guidelines)\b|\b(?:openai|anthropic|deepseek)'?s?\s+(?:policy|policies|guidelines|usage)\b/i },
    { id: 'policy-ru', kind: 'refusal', narration: 0.9, dialogue: 0.7,
        re: /(?<![\p{L}\p{N}])(?:политик\p{L}*|правил\p{L}*)\s+(?:контента|платформы|сервиса|безопасности\s+контента|использования\s+(?:сервиса|платформы|модели|ии))(?!\p{L})|(?<![\p{L}\p{N}])(?:этот|такой|подобный)\s+контент\s+(?:нарушает|противоречит|запрещ)/iu },
    { id: 'not-comfortable', kind: 'refusal', narration: 0.9, dialogue: 0.4,
        re: /\bI(?:'m|\s+am)\s+not\s+comfortable\s+(?:writing|continuing|generating|creating|describing|with\s+this\s+(?:request|content|roleplay))\b|(?<![\p{L}\p{N}])мне\s+(?:не\s+)?(?:комфортно|некомфортно)\s+(?:писать|продолжать|описывать|создавать)/iu },
    { id: 'assistant-offer', kind: 'refusal', narration: 0.85, dialogue: 0.5,
        re: /\b(?:is\s+there\s+anything\s+else|how\s+else\s+can)\s+I\s+(?:can\s+)?(?:help|assist)\b|\blet\s+me\s+know\s+if\s+you(?:'d|\s+would)\s+like\s+(?:me\s+to\s+)?(?:continue|adjust|change|proceed|explore)\b|(?<![\p{L}\p{N}])(?:чем\s+(?:ещё|еще)\s+(?:я\s+)?могу\s+(?:вам\s+|тебе\s+)?помочь|могу\s+ли\s+я\s+(?:ещё\s+|еще\s+)?(?:чем-то|чем-нибудь)\s+помочь)/iu },
    { id: 'apology', kind: 'refusal', narration: 0.8, dialogue: 0.3,
        re: /\bI\s+(?:apologize|'m\s+sorry|am\s+sorry),\s+but\s+(?:I|this|that)\b|(?<![\p{L}\p{N}])(?:прошу\s+прощения|извините),\s+но\s+(?:я\s+не|это)/iu },
    { id: 'change-topic-ru', kind: 'refusal', narration: 0.7, dialogue: 0.3,
        re: /(?<![\p{L}\p{N}])давайте\s+(?:сменим\s+тему|поговорим\s+о\s+ч[её]м-(?:то|нибудь)\s+другом|вернёмся\s+к\s+(?:сюжету|истории))/iu },
    // Out-of-role notes.
    { id: 'ooc', kind: 'refusal', narration: 0.9, dialogue: 0.9,
        re: /[([]\s*(?:OOC|ООС)\s*[:.)\]-]|(?:^|\n)\s*(?:OOC|ООС)\s*:/iu },
    { id: 'note', kind: 'refusal', narration: 0.85, dialogue: 0.6,
        re: /\(\s*(?:Note|NB|N\.B\.|Author'?s\s+note|A\/N|Примечание|Прим\.|Заметка|От\s+автора)\s*:/iu },
    { id: 'note-line', kind: 'refusal', narration: 0.8, dialogue: 0.4,
        re: /(?:^|\n)\s*[*_]*(?:Note|Disclaimer|Author'?s\s+note|Примечание(?:\s+автора)?|Дисклеймер|Content\s+warning|Trigger\s+warning|TW|CW)[*_]*\s*:/iu },
    // Moralising and disclaimers.
    { id: 'fiction-disclaimer', kind: 'moralizing', narration: 0.85, dialogue: 0.5,
        re: /\bthis\s+is\s+(?:a\s+|purely\s+|just\s+)*(?:fictional|fiction|a\s+work\s+of\s+fiction)\b|\b(?:in\s+a|for)\s+fictional\s+(?:context|purposes|scenario)\b|(?<![\p{L}\p{N}])(?:это|данн\p{L}*)\s+(?:всего\s+лишь\s+|лишь\s+)?(?:вымышлен|художественн)\p{L}*\s+(?:истори|сценари|произведени|текст|контекст)|в\s+рамках\s+(?:вымышленного|художественного)\s+(?:сценария|контекста|повествования)/iu },
    { id: 'real-life', kind: 'moralizing', narration: 0.6, dialogue: 0.3,
        re: /\bin\s+real\s+life\b|\breal-life\s+(?:consequences|situations?|relationships?)\b|(?<![\p{L}\p{N}])в\s+реальной\s+жизни(?!\p{L})/iu },
    { id: 'seek-help', kind: 'moralizing', narration: 0.9, dialogue: 0.5,
        re: /\bif\s+you\s+or\s+someone\s+you\s+know\b|\b(?:seek|reach\s+out\s+for)\s+professional\s+help\b|\bplease\s+seek\s+help\b|(?<![\p{L}\p{N}])(?:если\s+(?:вы|ты)\s+или\s+(?:кто-то|кто-нибудь)\s+из\s+(?:ваших|твоих)\s+близких|обрати(?:те)?сь\s+за\s+профессиональной\s+помощью)/iu },
    { id: 'important-to-remember', kind: 'moralizing', narration: 0.55, dialogue: 0.25,
        re: /\bit(?:'s|\s+is)\s+important\s+to\s+(?:remember|note|recognize|understand)\b|\bplease\s+(?:remember|note)\s+that\b|(?<![\p{L}\p{N}])важно\s+(?:помнить|понимать|отметить|учитывать),?\s+что(?!\p{L})/iu },
    { id: 'consent-lecture', kind: 'moralizing', narration: 0.8, dialogue: 0.35,
        re: /\bconsent\s+is\s+(?:important|key|essential|crucial|everything)\b|\bhealthy\s+(?:relationships?|boundaries)\b|(?<![\p{L}\p{N}])согласие\s+(?:—\s+это|важно|обязательно|превыше)|здоров\p{L}*\s+(?:отношени|границ)/iu },
    { id: 'behaviour-lecture', kind: 'moralizing', narration: 0.75, dialogue: 0.2,
        re: /\b(?:this|such)\s+(?:kind\s+of\s+)?behavio(?:u)?r\s+is\s+(?:not\s+okay|unacceptable|harmful|abusive)\b|\bit(?:'s|\s+is)\s+never\s+okay\s+to\b|(?<![\p{L}\p{N}])такое\s+поведение\s+(?:недопустимо|неприемлемо|ненормально)/iu },
    // Fade to black, skipped and blurred scenes («замыливание»).
    { id: 'fade-to-black', kind: 'softening', narration: 0.9, dialogue: 0.3,
        re: /\bfades?\s+to\s+black\b|\bfade-to-black\b|\bthe\s+scene\s+(?:fades|cuts|dims|goes\s+dark)\b|\bthe\s+curtain\s+(?:falls|closes|drops)\b/i },
    { id: 'fade-to-black-ru', kind: 'softening', narration: 0.9, dialogue: 0.3,
        re: /(?<![\p{L}\p{N}])(?:сцена\s+(?:затемняется|гаснет|меркнет|обрывается)|(?:^|\n)[ \t]*[*_([]*затемнение[ \t]*[.!…]*[*_)\]]*[ \t]*(?=\n|$)|занавес\s+(?:опускается|закрывается|падает))/iu },
    { id: 'left-unsaid', kind: 'softening', narration: 0.85, dialogue: 0.3,
        re: /\bwhat\s+(?:happens|happened)\s+next\s+(?:is|was|remains|stays)\s+(?:between|private|theirs|left\s+to)\b|\b(?:we(?:'ll|\s+will)|let's)\s+leave\s+(?:them|the\s+(?:two|couple|lovers))\b|\bthe\s+rest\s+is\s+history\b|\bdetails\s+(?:are\s+)?(?:best\s+)?left\s+to\s+(?:the\s+|your\s+)?imagination\b/i },
    { id: 'left-unsaid-ru', kind: 'softening', narration: 0.85, dialogue: 0.3,
        re: /(?<![\p{L}\p{N}])(?:история\s+умалчивает|оставим\s+(?:их|влюбл[её]нных|героев|эту\s+пару|парочку)\s+наедине|(?:опустим|пропустим)\s+(?:подробности|детали)|не\s+будем\s+(?:вдаваться\s+в\s+подробности|описывать)|(?:оста[её]тся|осталось|останется|остались|оставим)\s+за\s+кадром|(?:остальное|дальнейшее)\s*(?:—|-)?\s*(?:история|останется\s+между|осталось\s+между))/iu },
    { id: 'blur', kind: 'softening', narration: 0.6, dialogue: 0.2,
        re: /\b(?:the\s+rest\s+of\s+the\s+night|everything\s+else|what\s+followed)\s+(?:was|became|is)\s+a\s+blur\b|(?<![\p{L}\p{N}])(?:вс[её]\s+остальное|остаток\s+ночи|дальнейшее|что\s+было\s+дальше)\s+(?:слил|смешал|превратил|утонул|остал)\p{L}*\s+в\s+(?:одно\s+)?(?:размыт|туман|пятно|сплошн)/iu },
];

/** Consent questions (§11: endless «ты уверен?» is a defect only when repeated). */
export const CONSENT_RE =
    /\bare\s+you\s+(?:sure|certain)\b(?:\s+(?:you\s+want|about\s+this))?|\bis\s+(?:this|that)\s+(?:okay|ok|alright|all\s+right)(?:\s+with\s+you)?\s*\?|\bare\s+you\s+(?:okay|ok|alright|comfortable)\s+with\s+(?:this|that)\b|\bdo\s+you\s+want\s+me\s+to\s+(?:stop|continue|keep\s+going|go\s+on)\b|\b(?:tell|let)\s+me\s+(?:know\s+)?if\s+you\s+want\s+(?:me\s+)?to\s+stop\b|\bwe\s+can\s+stop\s+(?:at\s+any\s+time|whenever|anytime)\b|\byou\s+can\s+(?:always\s+)?say\s+no\b|\bonly\s+if\s+you\s+want\b|\bdo\s+you\s+consent\b|(?<![\p{L}\p{N}])(?:ты|вы)\s+(?:точно\s+|правда\s+|действительно\s+)?уверен(?:а|ы)?(?!\p{L})(?:\s+в\s+этом)?\s*\?|(?<![\p{L}\p{N}])(?:ты|вы)\s+(?:точно|правда|действительно)\s+(?:этого\s+)?хоч(?:ешь|ете)|(?<![\p{L}\p{N}])(?:ты|вы)\s+не\s+против\s*\?|(?<![\p{L}\p{N}])(?:тебе|вам)\s+(?:так\s+|это\s+)?(?:нормально|комфортно)\s*\?|(?<![\p{L}\p{N}])скажи(?:те)?,?\s+если\s+(?:захочешь|захотите|хочешь|нужно)\s+(?:остановиться|прекратить|чтобы\s+я\s+остановил)|(?<![\p{L}\p{N}])мне\s+(?:остановиться|продолжать|прекратить)\s*\?|(?<![\p{L}\p{N}])мы\s+можем\s+остановиться\s+(?:в\s+любой\s+момент|когда\s+(?:захочешь|захотите))/giu;

/* ------------------------------------------------------------------ verbs for «speaks for {{user}}» */

/** Russian speech verbs (stems; past and present, any gender). */
export const RU_SPEECH =
    '(?:сказал|говори|говорю|произн[её]с|произнос|ответил|отвеча|спросил|спрашива|прошептал|шепч|шепнул|воскликнул|восклица|крикнул|крич|пробормотал|бормоч|буркнул|добавил|добавля|заметил|замеча|выдохнул|хмыкнул|рявкнул|процедил|отозвал|согласил|соглаша|возразил|признал|продолжил|повторил|перебил|позвал|окликнул|прорычал|простонал|взмолил|пообещал|предложил|уточнил|пояснил|объяснил|протянул)\\p{L}*';
/** Russian action verbs that decide what a character does. */
export const RU_ACTION =
    '(?:кивнул|кивает|кивну|улыбнул|улыба|усмехнул|усмеха|ухмыльнул|шагнул|шага|подош[её]л|подошл|подход|взял|бер[её]т|обнял|обнима|поцеловал|целу|посмотрел|смотрит|взглянул|вздохнул|вздыха|рассмеял|засмеял|смеется|смеётся|пожал|сел|села|сели|садится|встал|вста[её]т|наклонил|наклоня|коснул|каса|прижал|прижима|отвернул|нахмурил|замер|замерл|повернул|поворачива|двинул|схватил|хвата|положил|кладет|кладёт|открыл|открыва|закрыл|закрыва|вош[её]л|вошл|входит|вышел|вышл|выходит|почувствовал|чувствует|решил|реша|подумал|думает|покачал|опустил|поднял|сжал|пров[её]л|ид[её]т|пош[её]л|пошл)\\p{L}*';
/** English speech verbs. */
export const EN_SPEECH =
    '(?:says|said|asks|asked|replies|replied|whispers|whispered|murmurs|murmured|mutters|muttered|shouts|shouted|yells|yelled|exclaims|exclaimed|adds|added|answers|answered|responds|responded|continues|continued|growls|growled|snaps|snapped|breathes|breathed|calls|called|repeats|repeated|agrees|agreed|insists|insisted|admits|admitted|protests|protested|grumbles|grumbled|teases|teased|purrs|purred|tells|told)';
/** English action verbs. */
export const EN_ACTION =
    '(?:nods|nodded|smiles|smiled|grins|grinned|smirks|smirked|laughs|laughed|chuckles|chuckled|sighs|sighed|walks|walked|steps|stepped|reaches|reached|takes|took|pulls|pulled|leans|leaned|looks|looked|turns|turned|feels|felt|decides|decided|thinks|thought|kisses|kissed|hugs|hugged|grabs|grabbed|sits|sat|stands|stood|moves|moved|wraps|wrapped|places|placed|follows|followed|glances|glanced|shrugs|shrugged|frowns|frowned)';

/** Russian «ты/вы»-narration verbs deciding the user's actions (perception verbs are fine: GM style). */
export const RU_YOU_ACTION =
    '(?:говоришь|говорите|сказал|сказала|сказали|отвечаешь|отвечаете|ответил|ответила|ответили|киваешь|киваете|кивнул|кивнула|кивнули|улыбаешься|улыбаетесь|улыбнулся|улыбнулась|улыбнулись|делаешь|делаете|сделал|сделала|сделали|берёшь|берешь|берёте|берете|взял|взяла|взяли|идёшь|идешь|идёте|идете|пошёл|пошел|пошла|пошли|подходишь|подходите|подошёл|подошел|подошла|подошли|решаешь|решаете|решил|решила|решили|соглашаешься|соглашаетесь|согласился|согласилась|согласились|тянешься|тянетесь|протягиваешь|протягиваете|протянул|протянула|целуешь|целуете|поцеловал|поцеловала|обнимаешь|обнимаете|обнял|обняла|садишься|садитесь|сел|села|сели|встаёшь|встаешь|встаёте|встаете|встал|встала|встали|поворачиваешься|поворачиваетесь|повернулся|повернулась|шагаешь|шагаете|шагнул|шагнула|открываешь|открываете|открыл|открыла|хватаешь|хватаете|схватил|схватила|прижимаешь|прижимаете|прижал|прижала|шепчешь|шепчете|прошептал|прошептала|стонешь|стонете|застонал|застонала|сдаёшься|сдаешься|сдался|сдалась|подчиняешься|подчинился|подчинилась)(?!\\p{L})';
/** English «you»-narration verbs deciding the user's actions. */
export const EN_YOU_ACTION =
    "(?:say|said|tell|told|reply|replied|answer|answered|ask|asked|nod|nodded|smile|smiled|grin|grinned|decide|decided|agree|agreed|walk|walked|step|stepped|reach|reached|take|took|grab|grabbed|pull|pulled|push|pushed|kiss|kissed|hug|hugged|lean|leaned|sit\\s+down|sat\\s+down|stand\\s+up|stood\\s+up|follow|followed|open|opened|close|closed|raise|raised|wrap|wrapped|whisper|whispered|laugh|laughed|shrug|shrugged|let\\s+out|can't\\s+help|cannot\\s+help|give\\s+in|gave\\s+in|obey|obeyed|comply|complied|accept|accepted|moan|moaned|gasp|gasped)(?![\\p{L}])";
