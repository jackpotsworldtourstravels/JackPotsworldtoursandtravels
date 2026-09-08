# CR-10 — Voice Calling (WebRTC)

Internet voice between a customer in Support Center and an agent in Live Support.
Not a phone call, not SIP, not PSTN, no Twilio/Agora/Vonage — WebRTC peer-to-peer,
with the existing chat socket used only to introduce the two browsers to each other.

---

## 0. What this adds, and what it must not disturb

CR-9 shipped live chat: a conversation per customer, a WebSocket gateway proven
across two workers, an agent console. CR-10 adds a call **inside** that
conversation and changes nothing about how a message is sent.

The rule throughout: **chat is what customers depend on**. Every design choice
that could put chat at risk was made the other way, and `voice_calls_enabled` is
a settings kill switch so the call buttons can be pulled without a deploy while
chat keeps running.

---

## 1. Why not the stack in the brief

The brief specifies Socket.IO, Prisma models and React components. This project
is FastAPI + SQLAlchemy + Alembic, with a static HTML/vanilla-JS frontend and no
build step — the same mismatch CR-9 resolved in favour of the real stack, and
resolved the same way here.

**Socket.IO specifically.** It would mean a second server with its own auth,
its own fan-out and its own scaling story, running beside a WebSocket gateway
that already has all three and is already proven across `WEB_CONCURRENCY=2`. The
brief's real requirement is the *event vocabulary* — `call_request`,
`call_accept`, `offer`, `answer`, `ice_candidate` and the rest — and that is a
set of names, not a library. Every one is implemented verbatim. Nothing in the
client's logic would differ under Socket.IO except the connect call.

The WebRTC half of the brief is followed exactly: `RTCPeerConnection`, Google
STUN, coturn for TURN, signalling over WebSocket, **media never through the
server**.

---

## 2. Architecture

```
   Customer browser                                      Agent browser
   ┌───────────────┐                                    ┌───────────────┐
   │ live-chat.js  │                                    │ admin-live-   │
   │ + webrtc-call │                                    │ support.js    │
   └───┬───────▲───┘                                    │ + webrtc-call │
       │       │                                        └───┬───────▲───┘
       │ WSS   │ signalling only                            │ WSS   │
       ▼       │  (SDP + ICE, opaque)                       ▼       │
   ┌──────────────────────────────────────────────────────────────────┐
   │  FastAPI  ·  chat_gateway → call_handlers → customer_call_service │
   │             call_signaling  ──►  Redis pub/sub  ──►  other worker │
   └──────────────────────────────────────────────────────────────────┘
       ▲                                                        ▲
       └──────────────── AUDIO NEVER COMES HERE ────────────────┘
                                   │
              ┌────────────────────┴────────────────────┐
              │   direct peer-to-peer, or via coturn    │
              └─────────────────────────────────────────┘
```

**The server is a relay for text and nothing else.** It forwards opaque SDP and
ICE strings between two browsers it has already decided are on a call together.
It does not parse SDP. If audio ever went through it, 8 kB/s of Opus per call
would land on the same event loop as the chat queue, and the first busy
afternoon would take both down.

---

## 3. The constraint that shaped it: agents are not looking at the thread

`AgentConnection` pumps only the conversations an agent has explicitly joined.
That is correct for chat — an agent with four hundred conversations should not
be woken by traffic on the three hundred and ninety-seven they are not reading.

It is fatally wrong for a call, which exists **to interrupt**, and which by
definition arrives about a conversation the agent is *not* currently reading.

So `chat_broker` gained a second kind of channel:

| Channel | Who subscribes | When |
|---|---|---|
| `chat:conv:{id}` | the customer, and any agent with that thread open | joined on demand |
| `chat:agent:{id}` | one agent | **for the whole socket's life** |

An incoming call is fanned out to each candidate agent's own channel —
addressed individually, not broadcast. A single "somebody is calling" channel
would be simpler and would also ring every agent in the company for a
conversation assigned to one of them.

`verify_voice_calls.py` deliberately **never sends `join_chat`** before ringing.
If the ring arrives, it can only have come via the agent channel.

---

## 4. Data model — `customer_calls` (migration 0066)

A call hangs off `customer_conversations` and inherits its scoping, its customer
and its assignment rules. There is no parallel "call session" concept and no
second place that knows who may talk to whom.

**A row is written when the caller presses Call, not when audio connects.** The
interesting outcomes are the ones where nothing happened — nobody answered, the
agent declined, the browser had no microphone. Writing the row on connect would
leave every one of those with no trace, and "Missed" could not appear in the
call log at all.

**`duration_seconds` is NULL for a call that never connected, not 0.** NULL means
"never connected"; 0 means "connected and lasted under a second". A support desk
arguing about a dropped call needs to tell them apart.

**Duration is measured from `connected_at`, not `answered_at`.** The seconds
spent exchanging SDP and gathering candidates are seconds nobody could speak in.
That matters the day these numbers are used to judge how long an agent spends
with a customer.

`admin_id` is a `users.user_id` **with no foreign key**, `admin_name`
denormalised beside it — the same B2C/B2B rule `customer_conversations` follows.

### Statuses

```
calling → ringing → accepted → connected → ended
   │         │          │           │
   │         │          └───────────┴────► failed
   ├─────────┼────► cancelled  (the CALLER hung up first)
   ├─────────┼────► rejected   (the callee declined)
   ├─────────┼────► missed     (rang out)
   └─────────────► busy        (callee already on a call)
```

`cancelled` is not in the brief's list, which has `missed` for both. They are
kept apart because they are facts about *different people*: missed is the agent
not answering, cancelled is the customer changing their mind. Collapsing them
makes an agent's miss-rate unmeasurable.

Terminal states have **no outgoing transitions**, which is what stops a late
`call_end` from a slow socket reopening a finished call.

---

## 5. The three races, and where each is decided

Production runs two workers. Check-then-act across two processes is not a race
anyone wins, so each is settled by the database:

| Race | Settled by |
|---|---|
| Two tabs press Call at once | `uq_customer_calls_live` — partial unique index on `conversation_id` filtered to the four live statuses |
| Two agents press Accept at once | `UPDATE … WHERE status IN ('calling','ringing')` — the loser gets `call_taken`, not an error |
| A late `call_end` after hangup | `CALL_TRANSITIONS`; terminal states are empty tuples |

### The index creates its own failure, so there is a sweeper

`uq_customer_calls_live` blocks a new call while an old row is still live. If a
worker is killed mid-ring, that row stays `ringing` **forever** and the
conversation can never place another call — a permanent, silent failure produced
by the very index that prevents a different one.

`expire_stale()` sweeps it, and runs at the moment somebody is actually blocked:
on every `call_request`. Ringing rows are swept aggressively; connected ones get
four hours, because a genuinely long support call must not be cut off by
housekeeping.

---

## 6. Signalling

### Events (all from the brief, verbatim)

| Client → server | Server → client |
|---|---|
| `call_request` | `incoming_call` |
| `call_accept` | `call_accepted` |
| `call_reject` | `call_status` |
| `call_cancel` | `call_cancelled` |
| `call_end` | `call_busy` |
| `call_connected` | `call_taken` |
| `call_failed` | `offer` / `answer` / `ice_candidate` |
| `offer` / `answer` / `ice_candidate` | |

`call_timeout` from the brief is delivered as `call_status` with
`status: "missed"` and `failure_reason: "ring_timeout"` — one envelope shape for
every outcome, so a client keeps a single call object and replaces it wholesale
rather than merging fields per event type. That is where a UI ends up showing a
stale timer or the previous call's name.

### The order of negotiation, and why it is not the obvious one

**The caller does not create an offer when it presses Call.** It waits for
`call_accepted`. An offer created earlier arrives at a browser with no
`RTCPeerConnection` yet and is dropped — the call then fails with both sides
showing "connected" and no audio, which is the single most confusing way for
this to break.

### The security model of the relay is one check

`_party_check`: is this socket a party to the call it named? That is all. It is
why the payload never needs to be understood to be safe — and without it, any
authenticated customer could send an `offer` naming any call id and have it
forwarded into a stranger's conversation. `verify_voice_calls.py` asserts a
third account is refused **and** that its SDP never reaches the agent.

Call ids on the wire are `public_id` (uuid4), never the integer primary key.
Guessing an integer is arithmetic.

---

## 7. Who may answer

The brief says "only assigned admins can answer customer calls". Taken literally
that deadlocks an unassigned conversation: nobody is assigned until somebody
accepts, and auto-assignment only runs on a *message* — and a customer whose
first contact is a call is never going to send one.

So:

- **Assigned conversation** → only its owner is rung, and only they may answer.
- **Unassigned** → every available agent is rung; whoever answers **claims** it,
  exactly as pressing Accept on the chat would.

The rule the brief is protecting — that a random agent cannot pick up a
conversation somebody else is handling — holds either way.

An agent already on a call gets `call_busy` from the server rather than a second
popup over the first.

---

## 8. TURN is not optional, whatever the default says

**This is the one thing in this document that costs money and cannot be skipped.**

STUN tells a browser its own public address so two peers can try to connect
directly. It only works when at least one side can accept an inbound packet.
Behind **symmetric NAT or carrier-grade NAT it cannot**, and the call fails with
no error the customer can act on.

India's mobile networks run CGNAT as standard — Jio and Airtel both. A
meaningful share of this customer base is exactly the population STUN does not
serve. Those calls do not degrade; they never connect.

`/api/customer/chat/ice` logs a warning every time a browser asks for a config
while `TURN_URLS` is empty, and returns `turn_configured: false` so the client
can log it too. See §12 for the coturn deployment.

ICE config is **served, not hardcoded** — `frontend/` is served by this same
process, so a TURN credential in a JS file is a public TURN credential. The
endpoint is authenticated: an unauthenticated one is an open relay with a login
page next to it.

---

## 9. Files

```
backend/alembic/versions/0066_customer_voice_calls.py   the table
backend/app/models_customer.py                          CustomerCall, CALL_TRANSITIONS
backend/app/services/customer_call_service.py           the state machine; no transport
backend/app/services/call_signaling.py                  addressing + ICE config
backend/app/services/call_handlers.py                   frame handlers, written ONCE for both sides
backend/app/services/chat_broker.py                     + agent channels
backend/app/services/chat_gateway.py                    + call dispatch on both sockets
backend/app/routers/customer_chat.py                    GET /ice, GET /calls
backend/app/routers/admin_chat.py                       GET /ice, GET /conversations/{id}/calls

frontend/assets/js/webrtc-call.js                       one call, from either side
frontend/assets/js/live-chat.js                         + call button, panel, log
frontend/assets/js/admin-live-support.js                + incoming popup, in-call bar
frontend/assets/css/live-chat.css                       + call styles
frontend/assets/css/live-support.css                    + call styles

tests/verify_voice_calls.py                             57 checks
docs/CR-10_VOICE_CALLS.md                               this file
```

`call_handlers.py` and `webrtc-call.js` are each written **once for both sides**
for the same reason: a call is symmetric. Both parties capture a microphone,
both build a peer connection, both trickle candidates. Only *who creates the
offer* and *how a frame is addressed* differ, and both are parameters. Two
copies would mean two copies of the negotiation, and the copy that gets
forgotten during the next change is the one that leaves a customer listening to
silence.

---

## 10. Client details worth knowing

**Mute disables the track; it never stops it.** A stopped `MediaStreamTrack`
cannot be restarted without a fresh `getUserMedia` — so unmuting would prompt
for permission mid-call.

**`reset()` stops every track.** A track left running keeps the browser's
microphone indicator lit after the call ends, which reads to a customer as "this
site is still listening to me".

**ICE candidates are queued until the remote description is set.** With trickle
ICE the first candidates routinely beat the answer, and `addIceCandidate` throws
if called too early. Not an edge case — the normal case.

**`disconnected` is not `failed`.** A phone switching from wifi to mobile data
spends a second or two in `disconnected` and recovers on its own. Only `failed`
triggers an ICE restart, and only the **caller** restarts — both sides
restarting produces two offers and glare.

**Connection quality is measured, not guessed.** `getStats` gives inbound packet
loss; >8% is "Poor connection". Emitted only when the rating changes.

**The microphone is requested before anyone is rung.** Ringing an agent and
*then* discovering the customer has no microphone wastes the agent's attention
and shows the customer a failure after a delay that made it look like a network
problem.

Every microphone failure gets its own sentence — permission denied, no device,
device busy, insecure origin, unsupported browser — because each is something
different for the person to do.

---

## 11. Responsive

The customer call surface is a banner under the chat header: the thread stays
readable, so a customer can still see the booking reference the agent just asked
for. It shrinks once connected. The agent card sits above the thread rather than
floating as a modal — a modal steals the keyboard from an agent mid-sentence in
another conversation.

The console's existing breakpoints (1200px drops the context pane, 860px goes to
one column) carry the call card unchanged.

---

## 12. Deployment

### 12.1 Environment

```bash
VOICE_CALLS_ENABLED=true
STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_URLS=turn:turn.jackpotsworldtours.com:3478,turns:turn.jackpotsworldtours.com:5349
TURN_USERNAME=jwt-turn
TURN_PASSWORD=<a long random secret>
```

`REDIS_URL` is already required by CR-9 and is **equally required here**: call
state and the agent channels cross workers.

### 12.2 coturn on the EC2 box

```bash
sudo dnf install -y coturn
```

`/etc/coturn/turnserver.conf`:

```
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech
user=jwt-turn:<the same secret as TURN_PASSWORD>
realm=jackpotsworldtours.com
# The instance's PRIVATE address, and its PUBLIC one. coturn binds the first
# and advertises the second; on EC2 they are never the same, and getting this
# wrong is the usual reason a TURN server appears to work and relays nothing.
listening-ip=<private IPv4>
external-ip=<elastic IP>/<private IPv4>
min-port=49152
max-port=65535
# Refuse to relay to private ranges. Without this the TURN server is a hole
# straight into the VPC for anyone holding the credential.
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
cert=/etc/letsencrypt/live/turn.jackpotsworldtours.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.jackpotsworldtours.com/privkey.pem
```

```bash
sudo systemctl enable --now coturn
```

**Security group**: 3478 TCP+UDP, 5349 TCP, and **49152–65535 UDP** — the relay
range. Miss the UDP range and TURN completes its handshake and then relays
nothing, which looks exactly like the failure it was installed to fix.

Verify from outside the VPC with <https://icetest.info> or Google's
[Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/):
a working TURN server produces at least one candidate of type `relay`. If you
only see `host` and `srflx`, TURN is not working — regardless of what the logs say.

### 12.3 HTTPS is mandatory

`getUserMedia` is unavailable on an insecure origin. Caddy already terminates
TLS; `webrtc-call.js` checks `window.isSecureContext` and says so plainly rather
than failing with "undefined is not a function".

### 12.4 Rollout

`bash deploy/redeploy.sh` — `docker-entrypoint.sh` applies `0066` on boot. To
ship without TURN, set `VOICE_CALLS_ENABLED=false` until coturn is up: the
buttons disappear and chat is untouched.

---

## 13. What is NOT built

Stated here rather than discovered later.

1. **No call recording.** Not asked for, and it is a legal question
   (two-party consent) before it is a technical one.
2. **No group or transfer-during-call.** An agent can transfer the *chat*; the
   call has to end first.
3. **No push notification for a missed call.** A customer whose call rang out
   sees it in Recent Calls next time they open Support Center. Reaching them
   when the tab is closed needs the notification work CR-9 §12 lists.
4. **No TURN credential rotation.** `TURN_USERNAME`/`TURN_PASSWORD` are static
   long-term credentials. coturn supports time-limited ones (`use-auth-secret`)
   and that is the better answer at volume; `ice_ttl_seconds` exists so the
   client already re-fetches.
5. **Real audio between two browsers has not been verified by the author.** The
   signalling path is proven end to end by `verify_voice_calls.py` — every frame
   followed from one socket to the correct other one — but the development
   environment has no microphone, so the last hop (two real browsers exchanging
   Opus) needs a human on two devices. **Do this before announcing the feature**,
   and do it once on mobile data with TURN configured, which is the path most
   likely to be broken.

---

## 14. Open questions

1. **Out-of-hours calling.** The footer promises 24/7. If nobody is online the
   customer is told immediately rather than left ringing — but "no agent is
   available" against a 24/7 promise is a contradiction a customer will notice.
   Should the call button hide outside staffed hours, or should the promise change?
2. **Recording and consent.** If calls are ever recorded, the Privacy Policy has
   to say so *before* the first one is, and both parties must be told at the
   start of the call.
3. **TURN bandwidth cost.** Every relayed call costs egress. Worth a cap, or at
   least an alarm, before the first busy month rather than after it.
