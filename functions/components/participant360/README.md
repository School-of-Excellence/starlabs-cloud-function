# participant360 — read-only participant lookup tools

16 tools that answer "what is going on with this participant" from the collections the Cloud
Functions already maintain. One HTTP function for Angular / Postman / QA; the same handlers are
exposed as a Messages-API tool registry for an AI support agent.

```
GET  /participant360                          tool catalogue (no auth)
GET  /participant360/resolve/{email|phone|id} { ok, profileid, email, name }
GET  /participant360/{tool}/{participantid}?limit=20&since=ISO[&<filter>=…]
     Authorization: Bearer <Firebase ID token>   caller must hold admin | ah | developer
```

Response (every tool, locked shape):

```json
{ "ok": true, "version": 1, "generatedAt": "ISO",
  "data": { "summary": { "headline": "…", "…": "…" }, "counts": { "total": 0, "returned": 0, "…": 0 }, "items": [ ] } }
```

`summary`, `counts`, `items` are the static keys; their contents are tool-specific. Reserved:
`summary.headline` (one-line string for the agent), `counts.total` (how many exist), `counts.returned`
(= `items.length` after `limit`), `items[].kind` when a tool mixes record types. `runTool()` rejects any
tool result that breaks this shape.

| Tool | Filter | Reads |
|---|---|---|
| purchase | — | participant metadata, participantjourneyproduct (`participantproducts[]` → enrollments), participantsproduct, journey/products/package |
| finance | — | Watson: Participants (`pp_*` = EMI plan), ParticipantPurchases, ParticipantPayments, Payment Schedule — joined by **email** |
| activeProduct | — | participantsproduct, participantdeliverysequence, deliverables |
| forms | `status` | `firestore-forms`/formsByClient, quizbyclients |
| appointment | `status` | appointments (bookedby as string or ref), appointmenttype, openviduroom |
| queue | — | queue_token, queue stage log, queue activity log, live assignment (status/stage/pairing only), cohorts queue planner |
| events | `kind` | event participation request, event collection, e-ticket eligibility, biginvitation, arena participant, event zones |
| communication | `channel` | wati logs (by phone), email logs (by email), notificationrecord (profileid[]), notifications/{uid}/logs, FCM_token |
| recommendation | — | recommended mix playlist, content analytics (progress), episodes, procedure_recommend |
| content | `type` | content analytics, episodes, participant workshop |
| mode | — | participant metadata (productmode[]), modes, eiflixhomewidgets, participantmetadata exception |
| roles | `includeDenied` | profile_data.role_ref → users_roles, eisroles, dashboard (route ACL) |
| videoAsk | `kind` | arenavideoask, participantvideoask |
| evolutionMapping | — | liveevolutionmapping, evolutionmappingvideo, accelerated evolution level, participant AEL, evolutionwishlistlog |
| systemBilling | — | Watson ledger (variant a — participant side; org-side vendor billing has no data source) |
| profileAuthentication | — | auth.getUser, profile_data, new_user_data, emailOTPs, timeline log, firestore_audit_log, FCM_token |

## Layout

```
participant360/
├── index.js        registry TOOLS[] · runTool() · toolDefinitions() · HTTP front door `participant360`
├── envelope.js     pure helpers + envelope(); no Firestore
├── collection.js   frozen allow-list { KEY: { db, name } }, db ∈ default | forms | watson — the ONLY
│                   file that opens Firestore. There is no "atc" branch (test enforces it).
├── resolve.js      profileid | email | phone → { profileid, email, name, uid, phone }
└── tools/<name>.js one per tool: { name, description, input_schema, sources, handler, load, project }
                    project(raw, opts) is pure and unit-tested; load() fetches then projects.
```

## Setup

* **Watson**: set the secret once — `firebase functions:secrets:set WATSON_SERVICE_ACCOUNT` and paste the
  Watson service-account JSON. Without it `finance` / `systemBilling` return an empty envelope whose
  headline says so; every other tool is unaffected.
* **Indexes** the queries need (deploy will name any that are missing): `appointments(bookedby)`,
  `content analytics(profileid, logdate desc)`, `notificationrecord(profileid array-contains, date desc)`,
  `queue_token(profile_id)`, `queue stage log(profile_id)`, `event participation request(profileid)`.
* **Emulator**: not in `index.emulator.js` on purpose (that entry is the queue e2e gate). Add it there if
  the e2e hub gets a participant360 suite.

## Agent use

```js
const { toolDefinitions, runTool, toToolResult } = require("./components/participant360");
// tools: toolDefinitions()  → pass to messages.create({ tools })
// on tool_use:  const outcome = await runTool(block.name, block.input, { audit });
//               toolResults.push(toToolResult(block.id, outcome));
```

## Probing the test database (read-only)

```
node scripts/participant360/probe-all.js <profileid|email> --sa <starlabs-test key.json>          # all 16 tools -> participant360-<pid>.json
node scripts/participant360/probe-purchase.js <profileid|email> --sa <key.json> --raw --out o.json  # one tool (default purchase) + raw docs
npm run p360:probe:all -- <profileid> --sa <key.json>     ·     npm run p360:probe -- <profileid> --sa <key.json>
```
Both share `scripts/participant360/probe-lib.js` (unit-tested in `test/unit/participant360/probe.test.js`): the key must be a
service account for an allow-listed project (`starlabs-test`, `starlabs-test-19`, `starlabs-cicd`); production / Watson / CRM
project ids are hard-denied; ADC env vars are scrubbed before firebase-admin loads. Exit 0 ok · 1 tool failure · 2 usage · 3 refused.

## Tests

`npx jest test/unit/participant360` — envelope helpers, every tool's `project()` on synthetic docs,
registry invariants, and the structural ATC fence. No emulator needed.

## Not yet confirmed on real data (read defensively, see spec §7 in the e2e hub)

formsByClient draft flag and key names · WATI/Postmark webhook statuses (delivered/read/opened/clicked)
· `tokenstatus` → derived queue status mapping · Watson payment `amount`/`mode` keys · VideoAsk payload
keys · event zone ↔ participant join.
