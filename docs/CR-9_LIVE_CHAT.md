# CR-9 — Live Chat Support (B2C)

**Status: DESIGN, not yet built.** Approve or amend before implementation starts.
Companion documents: `docs/API_CONTRACT.md` (endpoint conventions),
`docs/RUNBOOK.md` §2 (migrations), `docs/AWS_DEPLOYMENT.md` (the box this lands on).

---

## 0. What this replaces, and what it must not disturb

A WhatsApp-style live chat between customers and support staff. **No tickets, no
subject, no category, no priority, no ticket ID** — the customer opens the chat and
types.

Three pieces of prior art matter, because two of them already do part of this job:

| Existing | What it is | What CR-9 does with it |
|---|---|---|
| `customer_support_tickets` + `customer_support_messages` (0054) | The B2C **ticket** system: subject, description, priority, status. UI in `account-center.js` ("Raise a support ticket", "My support tickets"). | **Replaced.** Data migrated into conversations (§3.4), tables retained read-only for one release, dropped in a follow-up migration. |
| `chat_service.py` + `partner-live-chat.js` | Live chat for the **merchant/partner** side. Conversations are `service_requests` rows, messages are `msg_logs`. Status machine `SUBMITTED → IN_REVIEW → COMPLETED`. | **Untouched.** Different audience, different identity root (`models_v2.User`, not `Customer`). CR-9 deliberately does not merge them — see §3.1. |
| `models_customer.py` Base | The B2C identity tree, isolated from the merchant tree by design. | CR-9's tables hang here. |

**Non-goal:** unifying merchant chat and customer chat. They share no identity table,
no auth scheme and no admin screen today. Merging them is a larger change with its own
risk, and nothing in this CR requires it.

---

## 1. Why not the stack in the brief

The brief specified NestJS + Prisma + Next.js 15 + Socket.IO. This platform is FastAPI
+ SQLAlchemy + Alembic behind static HTML and vanilla JS, deployed as one Docker image
via `deploy/redeploy.sh`. Building the specified stack would mean a second application
in a second language that could not reuse the `jpc_*` customer session, the admin
portal, `storage.py`, or the deploy pipeline — and would put Prisma against a database
Alembic owns.

**Decision: build in the existing stack.** The brief's *functional* contract — every
event name, status, feature and screen — is honoured in full. Only the runtime differs,
and §5 maps the Socket.IO event vocabulary onto the transport one-for-one.

---

## 2. The constraint that shapes everything: two workers

`render.yaml` and `deploy/docker-compose.yml` run **`WEB_CONCURRENCY=2`**. Gunicorn
forks two independent processes.

An in-process dictionary of WebSocket connections therefore **silently half-works**: a
customer whose socket landed on worker 1 and an agent on worker 2 can never see each
other, and roughly half of all messages vanish with no error anywhere. This is the
single most important fact in this document.

**Redis pub/sub is required, not optional.** Every worker subscribes to the channels
for the conversations it holds sockets for; every send publishes. Redis is the only new
infrastructure CR-9 introduces (§9).

The alternative — pinning chat to a single worker — is rejected: it makes chat a single
point of failure for a process that also serves booking traffic.

---

## 3. Data model

Three new tables on the `models_customer.py` Base. Names follow the existing
`customer_*` convention and the `<table>_id` primary-key convention.

### 3.1 `customer_conversations`

One row per customer, effectively forever. **The conversation is the unit, not the
issue** — that is the whole difference from a ticket.

| column | type | notes |
|---|---|---|
| `conversation_id` | BigInteger PK | |
| `customer_id` | FK → `customers` ON DELETE CASCADE | |
| `assigned_admin_id` | FK → `users.user_id`, NULL | NULL = unassigned, in the waiting queue |
| `status` | enum `waiting/active/resolved/closed` | §4 |
| `last_message` | String(500), NULL | denormalised for the admin list; avoids N+1 on the queue screen |
| `last_message_at` | timestamptz, NULL | the sort key for the admin queue |
| `customer_unread_count` | Integer, default 0 | drives the widget badge without a COUNT |
| `admin_unread_count` | Integer, default 0 | drives the queue badge |
| `created_at` / `updated_at` | timestamptz | |

**Unique partial index on `customer_id`** — one open conversation per customer:
`CREATE UNIQUE INDEX uq_customer_conversation_live ON customer_conversations (customer_id) WHERE status <> 'closed'`.
This is what makes "reopen Support Center → same conversation" a database guarantee
rather than application politeness, and it is what stops a double-clicked widget
creating two threads.

Index `(status, last_message_at DESC)` for the queue, `(assigned_admin_id, status)` for
"my chats".

### 3.2 `customer_chat_messages`

| column | type | notes |
|---|---|---|
| `message_id` | BigInteger PK | |
| `conversation_id` | FK → `customer_conversations` ON DELETE CASCADE | |
| `sender_type` | enum `customer/admin/system` | `system` for "Chat closed", "Assigned to…" |
| `sender_admin_id` | FK → `users.user_id`, NULL | set when `sender_type='admin'` |
| `body` | Text, NULL | NULL when the message is a bare attachment |
| `message_type` | enum `text/image/file/system` | |
| `client_msg_id` | String(64), NULL | **idempotency** — see below |
| `delivered_at` / `read_at` | timestamptz, NULL | receipts (§5.4) |
| `deleted_at` | timestamptz, NULL | soft delete; "delete own message" tombstones, never removes |
| `created_at` | timestamptz | |

**`client_msg_id` is not optional.** A reconnecting socket retries sends; without a
client-generated id and `UNIQUE (conversation_id, client_msg_id)`, every flaky mobile
connection duplicates messages. This is the chat equivalent of the booking idempotency
keys already in `0060`/`0061`, and it exists for the same reason.

Index `(conversation_id, message_id DESC)` — the only read path that matters (§7.2).

### 3.3 `customer_chat_attachments`

| column | type | notes |
|---|---|---|
| `attachment_id` | BigInteger PK | |
| `message_id` | FK → `customer_chat_messages` ON DELETE CASCADE | |
| `storage_key` | String(400) | validated by `storage.validate_key()` |
| `file_name` | String(255) | the customer's original name, for display only |
| `mime_type` | String(100) | |
| `file_size` | Integer | bytes |
| `created_at` | timestamptz | |

Files go through the **existing** `storage.py` (`LocalStorage` / `S3Storage`), under a
`chat/{conversation_id}/{uuid}{ext}` key. Nothing new is invented for storage, and
`validate_key()` already blocks traversal.

### 3.4 Migration `0064_customer_live_chat`

Parent: `0063_booking_confirmed_notif` (current head — confirm with `alembic history`,
and note §2 of the RUNBOOK on why numbers are not order).

`upgrade()`:
1. Create the three tables and their indexes.
2. **Migrate ticket history.** For each customer holding tickets: create one
   conversation; insert each ticket's `subject`/`description` as the first message of
   that thread (`"[subject]\n\ndescription"`, `sender_type='customer'`), then its
   messages in `customer_support_message_id` order, mapping `is_staff` → `sender_type`.
   Preserve original `created_at` throughout. Set `status='resolved'` for tickets that
   were closed, `'waiting'` otherwise.
3. Do **not** drop `customer_support_tickets` / `customer_support_messages`.

`downgrade()`: drop the three new tables only. The ticket tables were never touched, so
the downgrade is total and cannot lose data — which matters, because `0063 → 0052` had
to be run for real on 2026-09-03 and will be again.

**The ticket tables are dropped in `0065`, a separate migration, after one release has
proven the migrated history reads correctly.** Bundling the drop into `0064` would make
the rollback lossy for no gain.

---

## 4. Status machine and assignment

```
            customer sends first message
                        │
                        ▼
                    WAITING ──────────── auto-assign ─────────────┐
                        │                                          │
              admin claims (or auto)                               │
                        ▼                                          ▼
                     ACTIVE ◄────── reopen ────── RESOLVED ──── CLOSED
                        │                            ▲              ▲
                        └──────── admin resolves ────┘              │
                                        admin closes ───────────────┘
```

- **WAITING** — customer has written, nobody assigned.
- **ACTIVE** — an admin owns it. Only `assigned_admin_id` and supervisors may reply.
- **RESOLVED** — dealt with; still reopens instantly if the customer writes again.
- **CLOSED** — archived. A new customer message creates a **new** conversation
  (the partial unique index in §3.1 permits exactly this).

**Assignment** — `backend/app/services/chat_assignment.py`, run on the customer's
first message from **both** the socket handler and the REST fallback, so a customer whose
socket never connected still reaches an agent.

The pool is every `ACTIVE` admin whose role is in `_ADMIN_ROLES` — the same tuple
`get_current_admin` gates on, so the set a chat can be *given* to cannot drift from the
set allowed to *open* one. It is sorted by open-conversation count ascending, then by
`user_id`.

**Ties break on `user_id`, not longest-idle** (as an earlier draft of this section said).
Longest-idle needs a per-admin timestamp that nothing maintains, and inventing one would
have meant a second write on every message. `user_id` is deterministic, which is what the
tie-break actually has to be: two workers assigning two conversations in the same second
must not disagree about the ordering by accident of row order. The conditional `UPDATE`
makes the collision harmless when they land on the same admin anyway.

**Offline admins still get the chat, and the status still says `waiting`.** If nobody
holds a socket, the conversation is assigned — so it is in that admin's "Only mine" the
moment they sign in — but it is not marked `active`, because `active` means somebody is
on it. Assignment is a routing decision; status is a statement of fact, and letting the
first quietly overwrite the second would make the queue's own badges lie about how long a
customer has been waiting. `active` is set only when the chosen admin is online.

Presence comes from the broker (`is_online("admin:{id}")`, one call per candidate — the
pool is a handful of people, and `SCAN` on a shared Redis is a cost paid by everything
else on that instance). A presence lookup that raises is treated as "nobody is online"
rather than failing the send: routing is a hint, never a blocker.

The write is a single `UPDATE ... WHERE assigned_admin_id IS NULL` — the same shape
`claim()` uses, so auto-assignment and an agent pressing **Accept** in the same instant
resolve in the database rather than in Python. Losing that race is silent on purpose: the
chat has an owner either way, which is all the function was asked to achieve.

---

## 5. Transport

### 5.1 Endpoint

`WSS /api/customer/chat/ws` (customer) and `WSS /api/admin/chat/ws` (agent), both
FastAPI/Starlette WebSockets. Caddy already upgrades WebSocket connections with no
config change.

### 5.2 Authentication — the ticket handshake

The browser `WebSocket` constructor **cannot send an `Authorization` header**. The two
common workarounds are both wrong here: a token in the query string lands in Caddy's
access log and in any proxy in between; a cookie would need CSRF handling this codebase
does not currently do for the API.

**Design: a one-time ticket.**

1. `POST /api/customer/chat/ws-ticket` — authenticated normally through
   `get_current_customer`. Returns a random 32-byte ticket, stored in Redis at
   `chat:ticket:{ticket}` → `{customer_id}` with a **60-second TTL**.
2. The socket connects to `?ticket=…`. The server `GETDEL`s the key — **single use** by
   construction.
3. A ticket that is missing, expired or already spent closes the socket with 4401.

Identity is then held on the connection for its lifetime. Session expiry is enforced by
re-validating the underlying JWT on each `send_message`, not just at connect, so a
revoked session cannot keep talking through a socket opened an hour earlier.

### 5.3 Event vocabulary

Every event in the brief is preserved. The wire format is a JSON envelope
`{"event": "...", "data": {...}}` — the same names Socket.IO would have used, so
swapping in `python-socketio` later is a transport change and not a rewrite.

| Direction | Event | Payload |
|---|---|---|
| → | `join_chat` | `{conversation_id}` |
| → | `leave_chat` | `{conversation_id}` |
| → | `send_message` | `{conversation_id, body, client_msg_id, attachment_ids[]}` |
| ← | `receive_message` | the full message row |
| → | `typing_start` / `typing_stop` | `{conversation_id}` |
| ← | `typing` | `{conversation_id, actor, is_typing}` |
| → | `message_read` | `{conversation_id, up_to_message_id}` |
| ← | `read_receipt` | `{conversation_id, up_to_message_id, by}` |
| ← | `delivered` | `{message_id}` |
| ← | `presence` | `{actor_type, actor_id, status: online\|offline, last_seen}` |
| ← | `chat_assigned` | `{conversation_id, admin}` |
| ← | `chat_closed` / `chat_reopened` / `chat_resolved` | `{conversation_id}` |
| ← | `notification` | `{conversation_id, preview}` |
| ← | `error` | `{code, message}` |

`admin_join` / `customer_join` / `online` / `offline` from the brief collapse into
`presence`, and `upload_file` / `upload_image` are REST (§6.2) — both noted so the
mapping is explicit rather than silently dropped.

### 5.4 Receipts

Three states, matching the brief: **sent** (server has the row and echoes the id back
against `client_msg_id`), **delivered** (a socket for the other party received it), and
**read** (that party emitted `message_read`). `delivered_at`/`read_at` persist so a
receipt survives a reload — an in-memory-only receipt is the classic bug where
everything shows unread after refresh.

### 5.5 Fan-out and reconnect

Redis channel per conversation: `chat:conv:{id}`. Each worker subscribes on first local
socket, unsubscribes on last. Presence in `chat:presence:{actor}` with a TTL refreshed
by heartbeat, so a crashed worker's users go offline by expiry rather than staying
falsely online forever.

Client reconnect: exponential backoff 1s → 30s with jitter, `join_chat` replayed, and a
**gap fetch** — `GET /messages?after_id=` for anything missed while disconnected. Without
the gap fetch, reconnect appears to work and quietly loses every message sent during the
outage.

---

## 6. REST surface

All under the existing routers, `slowapi` limits on every write.

### 6.1 Customer
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/customer/chat/conversation` | The live conversation, creating one if none. **Never 404s** — this is what makes Support Center open straight into a chat. |
| GET | `/api/customer/chat/messages?before_id=&after_id=&limit=` | History page / reconnect gap fetch |
| POST | `/api/customer/chat/attachments` | Multipart upload → attachment row |
| POST | `/api/customer/chat/ws-ticket` | §5.2 |
| DELETE | `/api/customer/chat/messages/{id}` | Soft-delete own message |

### 6.2 Uploads are REST, deliberately

A 10 MB file pushed through the WebSocket blocks that socket's frame queue behind
itself — typing indicators and incoming messages stall until it finishes, and a failed
upload cannot resume without tearing down the connection. So the bytes go over HTTP. The
transport for the bytes and the transport for the news do not have to be the same one:
the server publishes the finished message on the conversation channel, so the other side
still learns about it immediately.

**One request, one message** — not "upload, get an `attachment_id`, then `send_message`
referencing it" as this section first proposed. That two-step needs a holding area for
uploaded-but-unsent files and a job to sweep the ones nobody ever sends, and it puts a
window between the two calls in which the client can crash holding a file the server has
no reason to keep. `POST /attachments` writes the message and the attachment row in one
transaction, and takes an optional caption and the same `client_msg_id` an ordinary send
uses, so a retried upload is idempotent by the mechanism already in place.

**One file per message**, the way a chat client sends one. A single message carrying five
files would need all five validated, stored and committed atomically, and a partial
failure halfway through has no good answer — the customer watched four succeed. One file
per message makes a failure the failure of one bubble, which the customer can retry by
itself.

Validation is `document_service.store_upload`, reused verbatim rather than reimplemented:
declared type **and** the leading byte signature must agree, and the **≤ 10 MB** cap is
enforced while streaming rather than from a client-supplied `Content-Length`. A rejected
upload never reaches storage. Filenames are never used as storage keys — the key is a
uuid under `chat/{conversation_id}/`, so a file called `../../etc/passwd` is an ugly label
and nothing more.

**Accepted: JPEG, PNG, WebP, PDF. `.doc` and `.docx` are refused**, though the brief lists
DOC. The brief's own examples — passport copies, tickets, screenshots — are all photos or
PDFs. `.doc` is an OLE compound file and `.docx` a zip; neither can be validated by a
leading signature the way the four accepted types can, both can carry macros, and a
support inbox is exactly where a hostile one would be sent. Widening the allowlist would
widen it for passport uploads too, which is not a trade this feature gets to make on that
feature's behalf. If Word files are genuinely needed, that is its own change with its own
scanning story.

**Photos are re-encoded to drop their EXIF**, and this is not polish. A customer
photographs their passport on a phone; that JPEG carries the GPS coordinates of wherever
it was taken, which for a passport is usually their home. `exif_transpose` runs *first* —
orientation is itself an EXIF tag, so stripping without applying it saves a sideways
passport. A re-encode that fails stores the original rather than losing the customer's
file. PDFs are passed through untouched and arrive byte-identical, which
`verify_live_chat.py` asserts: an e-ticket that differs by one byte is a broken e-ticket.

Downloads are `Content-Disposition: attachment` with `nosniff`, `default-src 'none'` and
`Cache-Control: private` — a support attachment is never rendered in this origin and never
held by a shared proxy. The client fetches it with the bearer token and renders from a
blob, because `<img src>` cannot send an `Authorization` header and a token in the query
string would land in every proxy log between the browser and the server.

### 6.3 Admin
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/chat/conversations?status=&q=&page=` | Queue + search (§8) |
| GET | `/api/admin/chat/conversations/{id}` | Thread + customer summary |
| POST | `/api/admin/chat/conversations/{id}/claim` | Accept from the waiting queue |
| POST | `/api/admin/chat/conversations/{id}/transfer` | `{to_admin_id}` |
| POST | `/api/admin/chat/conversations/{id}/status` | resolve / close / reopen |
| POST | `/api/admin/chat/conversations/{id}/messages` | Reply, or an internal note via `is_internal` |
| POST | `/api/admin/chat/conversations/{id}/attachments` | Send a file, `is_internal` honoured |
| GET | `/api/admin/chat/attachments/{id}` | Download any conversation's file |
| GET | `/api/admin/chat/agents` | Transfer targets |
| GET | `/api/admin/chat/analytics` | §8.2 |

There is **no `/notes` endpoint**. A note is the same POST as a reply with
`is_internal: true`, because it is the same row with one flag set, and a second endpoint
would be a second place for the audience rule to be got wrong.

Internal notes are `customer_chat_messages` rows with `sender_type='admin'` and
`is_internal` — **not** `sender_type='system'` as an earlier draft said, and not a
separate table. A note has an author and the thread shows it; `system` is reserved for
events nobody wrote ("Chat assigned to Priya"). They sort into the thread
chronologically where an agent expects them, and are filtered out of every
customer-facing query by `_visible()` in the service layer, in one place — including the
attachment download, which is why `attachment_for_customer` and `attachment_for_admin`
are separate functions rather than one with a flag. A note's file must be unreachable by
the customer even by guessing its id, and the safest guarantee of that is a customer
lookup with no code path that could return one.

---

## 7. Frontend

### 7.1 Files

```
frontend/assets/css/live-chat.css        widget + panel, own --lc-* tokens (as site-footer.css does)
frontend/assets/js/live-chat.js          LiveChat: socket, state, reconnect, render, upload
frontend/assets/css/live-support.css     agent console; reads the admin theme's tokens
frontend/assets/js/admin-live-support.js Admin section, follows admin-*.js conventions
```

Backend, for the same map:

```
backend/app/routers/customer_chat.py     REST + the customer socket
backend/app/routers/admin_chat.py        the agent queue, thread, replies, files
backend/app/services/customer_chat_service.py  the rules; knows no transport
backend/app/services/chat_gateway.py     socket handlers; one place that knows the envelope
backend/app/services/chat_broker.py      Redis fan-out, tickets, presence
backend/app/services/chat_assignment.py  who a chat goes to (§4) — the ONE file that
                                         crosses the B2C/B2B registry line, on purpose
backend/app/services/chat_attachments.py files (§6.2); wraps document_service, adds no
                                         validation of its own
```

The widget mounts exactly as the footer does — one script, no build step, no framework.
It renders into a single root it creates itself, so no page needs new markup.

### 7.2 Two entry points, one component

- **Floating button**, bottom-right, on every page, with an unread badge.
- **Profile → Support Center** calls `LiveChat.open()` — the *same* component, docked
  rather than floating. No navigation, no second implementation. The existing
  ticket panels in `account-center.js` are removed.

History loads newest-first, 30 per page, older fetched on scroll-to-top with the scroll
anchored so the viewport does not jump — the detail that separates a chat that feels
right from one that does not.

### 7.3 XSS

Every message body is rendered with `textContent`, never `innerHTML`. Links are
linkified by building `<a>` elements in code with the href validated against
`http:`/`https:` — never by regex-replacing into an HTML string. This is the one place
in the system where an attacker controls content that another user's browser renders, so
it gets the strict treatment.

### 7.4 States

Loading (skeleton bubbles), empty ("Need help? Our travel experts are here." + the
composer, never a blank box), error (inline retry, message kept in the composer),
offline (banner + queued sends flushed on reconnect), file-too-large / wrong-type
(rejected client-side *and* server-side).

Responsive: full-screen sheet under 640px, docked panel above. Dark mode via the
existing `data-theme` attribute. `prefers-reduced-motion` respected.

---

## 8. Admin module

New nav item `data-section="live-support"` in `frontend/admin/index.html`, beside
Support Management.

### 8.1 Layout
Three panes: queue (Waiting / Active / Resolved / Closed tabs with live counts) →
thread → customer context (profile, and booking history when CR-10 lands).

### 8.2 Search and analytics

Queue search (`?q=`) matches customer name, email, mobile, customer code, conversation id
— and **booking reference or airline PNR**, across all three booking products. The single
most common thing a customer opens with is "about booking JWT12345", and without it the
agent has to look that reference up in another screen to find out whose chat to open. The
customer does not know or care which of our tables their trip lives in, so it is one
`UNION ALL` over `customer_bookings`, `customer_hotel_bookings` and
`customer_package_bookings`.

The match is a **prefix** (`term%`), not `%term%`. A reference is quoted whole in a chat
or read off a ticket, so a prefix covers the real use; a leading wildcard would make this
an unindexable full scan of the busiest tables in the database, run on every keystroke of
the agent's search box.

Analytics are derived from the conversation rows — queue depth by status, first-response
and resolution times — with no metrics table behind them.

---

## 9. Deployment

**Redis is the only new infrastructure.** Add to `deploy/docker-compose.yml`:

```yaml
redis:
  image: redis:7-alpine
  command: ["redis-server", "--appendonly", "no", "--maxmemory", "256mb", "--maxmemory-policy", "allkeys-lru"]
  restart: unless-stopped
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
```

Not published to the host — reachable only on the compose network. No persistence:
everything in it (tickets, presence, pub/sub) is ephemeral by design, and an AOF file
would be a liability rather than an asset.

`REDIS_URL` into `backend/.env`. `redis>=5.0` into `requirements.txt` — and, with
slice 5, `Pillow>=10.4` for the EXIF re-encode (§6.2). Pillow was already on the box
as a transitive dependency of the OCR extras; it is declared so that stops being luck,
exactly as `requests` was after CR-8.

**Caddy needs no change** — it upgrades WebSockets automatically.

### 9.1 Capacity, honestly

The brief says "thousands of concurrent users". WebSockets are long-lived: 2 workers on
a `t3.small` will hold order-of a few thousand idle sockets before memory and file
descriptors bind, and the ceiling is memory per connection, not CPU. Before that point:
raise `WEB_CONCURRENCY`, raise the container's `nofile` limit, then run chat as its own
service against the same Redis. The Redis fan-out design means that last step is a
compose change, not a rewrite — which is the main reason it is designed this way now.

This should be load-tested before launch, not assumed.

---

## 10. Security checklist

| Requirement | How |
|---|---|
| JWT auth | Existing `get_current_customer` / `get_current_admin`; re-validated per send (§5.2) |
| WSS | Caddy terminates TLS already |
| Rate limiting | `slowapi` on REST; per-socket token bucket (20 msg/10s) on `send_message` |
| Spam | Duplicate-body suppression, per-conversation flood cap |
| XSS | §7.3 |
| CSRF | Bearer tokens, not cookies — no ambient authority to forge |
| SQL injection | SQLAlchemy parameter binding throughout; no string-built SQL |
| Input validation | Pydantic schemas on every payload, including socket frames |
| File validation | §6.2 — allowlist **and** byte-signature sniff, streamed size cap, uuid keys |
| Stored-file metadata | Photos re-encoded; EXIF (including phone GPS) does not reach storage — §6.2 |
| File download | `Content-Disposition: attachment`, `nosniff`, `default-src 'none'`, `Cache-Control: private`; never rendered in this origin |
| Internal-note files | A separate lookup for the customer with no code path that can return one (§6.3) |
| Authorisation | Every query filtered by `customer_id` or `assigned_admin_id`; **never trust `conversation_id` from the client** |
| Audit | `customer_audit_service` records claim, transfer, status change, deletion |

---

## 11. Build order

Each slice ships working and is independently verifiable.

1. **Migration + models + service layer.** No UI. Verified by `verify_live_chat.py`.
2. **REST endpoints + customer widget, polling-free but socket-less** — send/receive via
   REST first. Proves the data model and the UI before real-time is in play.
3. **WebSocket gateway + Redis fan-out.** Same UI, live. **Must be tested with
   `WEB_CONCURRENCY=2`** — a single-worker test proves nothing (§2).
4. **Admin Live Support module.** Shipped — and the slice that exposed the
   `datetime` serialisation bug which had made slice 3 a mirage in production: every
   socket send stored the message, acked it, and then failed inside `publish()`. See the
   commit; the reason 110 tests missed it is recorded there and is the more useful half.
5. **Attachments.** Shipped, plus auto-assignment and booking-reference search, both of
   which the brief asked for and slices 1–4 had not delivered.
6. **Emoji, arrival sound, drag-and-drop.** Shipped with slice 5. Browser notifications
   landed in slice 3. Presence exists in the broker and is consumed by auto-assignment;
   it is **not** yet surfaced in either UI.
7. **Not done: an analytics screen** (the endpoint exists, no UI), **transfer UI** (same),
   **and dropping the ticket tables.** The drop is deliberately deferred — `0064` reads
   them to migrate history and nothing else does, so they are dead weight rather than a
   hazard, and keeping them one release means a rollback does not need a restore.

`0065` is **not** the ticket-table drop this section originally planned for it. It fixes
a check constraint `0064` shipped that forbade exactly what `0064`'s own data migration
inserts — see the migration's docstring. The drop, when it happens, gets its own number.

`tests/verify_live_chat.py`, registered in `run_all.py` (`verify_m9.py` fails the suite
otherwise): conversation reuse across sessions, the partial unique index under
concurrent creation, idempotent resend, cross-customer access denied, oversized and
wrong-type uploads rejected, and two-worker fan-out.

---

## 12. Open questions

1. **Agent identity.** Admins are `models_v2.User`. Should customers see a real name and
   avatar, or a neutral "JackpotsWorld Support"? Affects the schema only slightly, the
   product a lot.
2. **24/7.** The site now advertises 24/7 support (2026-09-05). Out of hours, should the
   widget say "we typically reply in X minutes", or is the queue genuinely staffed
   overnight? This decides whether an away-state is needed at all.
3. **Retention. STILL OPEN, AND NOW LOAD-BEARING — attachments ship.** "Forever
   unless deleted by an administrator" is stated in the brief. Attachments include
   passport copies; the Privacy Policy says travel-document data is deleted once the trip
   and any claim are closed. **These two statements conflict** and the policy is the
   published promise. Nothing in slice 5 expires a file. Storage keys are scoped
   `chat/{conversation_id}/` specifically so a whole conversation's files can be removed
   in one operation once this is decided. Recommend: messages retained indefinitely,
   attachments purged on a schedule, and the policy amended to say so.

   The EXIF strip reduces the exposure — a stored passport photo no longer carries the
   customer's home coordinates — but it does not answer the question.
4. **Anonymous chat.** Chat before sign-in — supported, or authenticated only? Anonymous
   needs a browser-scoped identity and a merge-on-login path; not designed here.
