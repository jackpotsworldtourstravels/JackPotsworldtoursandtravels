'use strict';
/* ===========================================================================
   Live-support agent queue auto-refresh — the polling lifecycle.

   admin-live-support.js is a browser IIFE, so (like the other frontend tests)
   the REAL functions under test are extracted from the source and run in a vm
   with stubs for the globals they close over (document, setInterval, api,
   renderQueue/renderCounts, state). Nothing here imports the browser.

   The rules under test (the audit follow-up's 11 requirements):
     * one timer + one visibility listener, however many times init runs
     * the poll tick does nothing while document.hidden, and nothing while a
       request is already in flight (no overlap)
     * becoming visible refreshes promptly
     * a failed refresh never wipes a queue that is already on screen
     * a slow/stale response never overwrites a newer one
     * filters / "only mine" / search are always re-applied
     * the open conversation and its messages are never touched by a poll
     * teardown clears the timer and removes the listener

   run:  node frontend/tests/live-support-queue-polling.test.js
   =========================================================================== */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('assets/js/admin-live-support.js');

const failures = [];
const check = (cond, msg) => { if (!cond) failures.push(msg); };
const flush = () => new Promise(r => setImmediate(r));

/* Same brace-matching extractor the sibling tests use. */
function extractFn(src, sig) {
  const at = src.indexOf(sig);
  if (at === -1) { failures.push(`${sig} not found`); return ''; }
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(at, i + 1); }
  }
  failures.push(`${sig} braces unbalanced`);
  return '';
}

const code = [
  extractFn(SRC, 'async function loadQueue('),
  extractFn(SRC, 'function onQueueVisibility('),
  extractFn(SRC, 'function startQueuePolling('),
  extractFn(SRC, 'function stopQueuePolling('),
  extractFn(SRC, 'function teardown('),
  'this.fns = { loadQueue, onQueueVisibility, startQueuePolling, stopQueuePolling, teardown };',
].join('\n');

/* ------------------------------------------------------------------ harness */
function makeSandbox(overrides) {
  const calls = { api: [], render: 0, counts: 0, setInterval: 0, clearInterval: 0,
                  addListener: [], removeListener: [], listErrors: 0 };
  const timers = [];        /* captured interval callbacks, invoked manually */
  const listeners = {};     /* event name -> handler */

  const sandbox = {
    QUEUE_POLL_MS: 12000,
    URLSearchParams,
    console,
    state: {
      conversations: [], counts: {}, filter: 'waiting', mine: false, search: '',
      current: null, messages: [],
      queueSeq: 0, queueInFlight: false, queueTimer: null, queueVisibilityBound: false,
    },
    document: {
      hidden: false,
      addEventListener: (name, fn) => { calls.addListener.push(name); listeners[name] = fn; },
      removeEventListener: (name) => { calls.removeListener.push(name); delete listeners[name]; },
      getElementById: () => ({ set innerHTML(v) { sandbox.__list = v; } }),
    },
    setInterval: (fn) => { calls.setInterval++; timers.push(fn); return timers.length; },
    clearInterval: () => { calls.clearInterval++; },
    renderQueue: () => { calls.render++; },
    renderCounts: () => { calls.counts++; },
    api: (p) => { calls.api.push(p); return Promise.resolve({ conversations: [], counts: {} }); },
  };
  Object.assign(sandbox, overrides || {});
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return { sandbox, calls, timers, listeners };
}

async function run() {
  /* ---- req 5: one timer + one listener however many times we start ------- */
  {
    const { sandbox, calls } = makeSandbox();
    sandbox.fns.startQueuePolling();
    sandbox.fns.startQueuePolling();
    sandbox.fns.startQueuePolling();
    check(calls.setInterval === 1, `one timer only (got ${calls.setInterval})`);
    check(calls.addListener.filter(n => n === 'visibilitychange').length === 1,
      'one visibilitychange listener only');
    check(sandbox.state.queueTimer !== null, 'queueTimer recorded');
  }

  /* ---- req 2: tick does nothing while hidden ----------------------------- */
  {
    const { sandbox, calls, timers } = makeSandbox();
    sandbox.fns.startQueuePolling();
    sandbox.document.hidden = true;
    timers[0]();                              /* a tick */
    check(calls.api.length === 0, 'hidden tab: tick must not call api');
    sandbox.document.hidden = false;
    timers[0]();                              /* a tick while visible */
    check(calls.api.length === 1, 'visible tab: tick calls api once');
  }

  /* ---- req 4: tick does not stack on a request already in flight --------- */
  {
    const { sandbox, calls, timers } = makeSandbox();
    sandbox.fns.startQueuePolling();
    sandbox.state.queueInFlight = true;       /* pretend a load is running */
    timers[0]();
    check(calls.api.length === 0, 'in-flight: tick must not start a second request');
  }

  /* ---- req 3: becoming visible refreshes promptly ------------------------ */
  {
    const { sandbox, calls } = makeSandbox();
    sandbox.document.hidden = false;
    sandbox.fns.onQueueVisibility();
    check(calls.api.length === 1, 'visible again: refresh fires');
    const { sandbox: s2, calls: c2 } = makeSandbox();
    s2.document.hidden = true;
    s2.fns.onQueueVisibility();
    check(c2.api.length === 0, 'still hidden: visibility handler does not fire');
  }

  /* ---- req 9: a failed refresh must not wipe a populated queue ------------ */
  {
    const existing = [{ conversation_id: 1, customer_name: 'A' }];
    const { sandbox } = makeSandbox({ api: () => Promise.reject(new Error('boom')) });
    sandbox.state.conversations = existing.slice();
    await sandbox.fns.loadQueue();
    check(sandbox.state.conversations.length === 1, 'failed refresh keeps existing rows');
    check(sandbox.__list === undefined, 'failed refresh with data shows no error banner');
  }
  {
    /* first load, nothing on screen yet -> the error IS shown */
    const { sandbox } = makeSandbox({ api: () => Promise.reject(new Error('boom')) });
    await sandbox.fns.loadQueue();
    check(/Could not load the queue/.test(sandbox.__list || ''),
      'first load failure shows the error banner');
  }

  /* ---- req 10: a stale (older) response never overwrites a newer one ------ */
  {
    const resolvers = [];
    const { sandbox } = makeSandbox({ api: () => new Promise(res => resolvers.push(res)) });
    const A = sandbox.fns.loadQueue();        /* seq 1 */
    const B = sandbox.fns.loadQueue();        /* seq 2 */
    resolvers[1]({ conversations: [{ conversation_id: 2 }], counts: { waiting: 1 } });  /* newer lands first */
    await flush();
    resolvers[0]({ conversations: [{ conversation_id: 9 }], counts: { waiting: 9 } });  /* older lands late */
    await Promise.all([A, B]); await flush();
    check(sandbox.state.conversations.length === 1 && sandbox.state.conversations[0].conversation_id === 2,
      'newer response wins; stale one is ignored');
    check(sandbox.state.queueInFlight === false, 'in-flight flag cleared after the newest load');
  }

  /* ---- req 7: filters / mine / search are re-applied --------------------- */
  {
    let seen = '';
    const { sandbox } = makeSandbox({ api: (p) => { seen = p; return Promise.resolve({ conversations: [], counts: {} }); } });
    sandbox.state.filter = 'active'; sandbox.state.mine = true; sandbox.state.search = 'goa';
    await sandbox.fns.loadQueue();
    check(/status=active/.test(seen) && /mine=true/.test(seen) && /q=goa/.test(seen),
      `poll re-applies the current view (got "${seen}")`);
  }

  /* ---- req 8: a poll never touches the open conversation or messages ------ */
  {
    const { sandbox } = makeSandbox();
    const current = { conversation_id: 5 };
    const messages = [{ message_id: 1 }];
    sandbox.state.current = current; sandbox.state.messages = messages;
    await sandbox.fns.loadQueue();
    check(sandbox.state.current === current, 'open conversation untouched by a poll');
    check(sandbox.state.messages === messages, 'open thread messages untouched by a poll');
  }

  /* ---- req 6: teardown clears the timer and removes the listener ---------- */
  {
    const { sandbox, calls } = makeSandbox();
    sandbox.fns.startQueuePolling();
    sandbox.fns.teardown();
    check(calls.clearInterval === 1, 'teardown clears the interval');
    check(sandbox.state.queueTimer === null, 'teardown nulls queueTimer');
    check(calls.removeListener.includes('visibilitychange'), 'teardown removes the visibility listener');
    check(sandbox.state.queueVisibilityBound === false, 'teardown unbinds the visibility flag');
  }

  /* ---- interval value is the intended ~12s ------------------------------- */
  check(/const QUEUE_POLL_MS = 12000;/.test(SRC), 'poll interval is 12000ms');

  if (failures.length) {
    console.error('FAIL (' + failures.length + '):');
    failures.forEach(f => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('live-support queue polling: all checks passed');
}

run().catch(err => { console.error('ERROR', err); process.exit(1); });
