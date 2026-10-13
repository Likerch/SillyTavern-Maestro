# Officina task fixtures

Replies of the mock model for Officina's tasks (`SillyTavern-Officina`, its plan §9.3). Officina names the JSON schema of
a request after its task (`officina.bible` → `officina_bible`), and the mock answers a request with an `officina_*`
schema from `<task>.json` here — `officina.bible.json`, or `officina_bible.json` — holding a partial reply object or an
array of them (one is picked per request, deterministically); missing required fields are filled from the request's
schema, and without a file the schema walker alone answers. `MOCK_OFFICINA_FIXTURES=<dir>` reads them from another
folder; the mock reads each file once, so restart it after an edit (tools/mock-llm/README.md, «Neighbour tasks»).
