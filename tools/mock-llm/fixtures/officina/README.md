# Officina task fixtures

Replies of the mock model for Officina's tasks (`SillyTavern-Officina`, its plan §9.3). Officina names the JSON schema of
a request after its task (`officina.bible` → `officina_bible`), and the mock answers a request with an `officina_*`
schema from `<task>.json` here — `officina.bible.json`, or `officina_bible.json` — holding a partial reply object or an
array of them (one is picked per request, deterministically); missing required fields are filled from the request's
schema, and without a file the schema walker alone answers. `MOCK_OFFICINA_FIXTURES=<dir>` reads them from another
folder; the mock reads each file once, so restart it after an edit (tools/mock-llm/README.md, «Neighbour tasks»).

Stage 2 (co-author): `officina.coauthor.json` holds three rounds of the JSON action protocol (`{reply, actions: [{tool,
args}]}`, args as JSON text) — read the map and the bible; read the first card and cast member and propose a new
description; propose a darker secret, a lore event and a new cast member. The mock picks one per request, so each stands
on its own: Officina stops asking once a round brings nothing new to read, and drops a proposal it already holds. Node
ids are `card:#1`, `cast:#1`, `bible` (any project). `officina.extract.json` fills every part (card, entries, cast,
note) — the bridge takes the part of the kind the author chose; `officina.check.json` names places by `bible`,
`skeleton`, `cast:#1`, `card:#1` and by names of the stand's skeleton (`cast:Эдвин Морр`, `place:Старый маяк`).

Stage 5 (playtest, adaptation): `officina.player.json` holds five player messages of the auto-player (`{message,
aim}`; one is picked per turn) in the harbour setting of the stand, written as a player would type them — never for the
characters. `officina.report.json` is a playtest report (`summary`, `checks` by area — voice, intent, player, tracker,
mechanics, lore, greeting — and `findings` with places `card:#1`, `cast:#1`, `bible`, `faction:Гильдия фонарщиков` and
turn numbers): «Исправить в проекте» opens each place. `officina.adapt.json` adapts an English card («Captain Mara
Vance», W++ description, two greetings) into a Russian project: bible, skeleton (two cast members, two scenes, one per
greeting), the card, three typed lore entries split out of the description, one mechanic idea and two notes.
`officina_adapt_lore.json` answers each batch of a long foreign book (`officina.adapt.lore`; the mock looks the file up by
the schema name `officina_adapt_lore`, since the task's second dot is not a separator there) with two adapted entries.
