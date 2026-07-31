"""Concurrency check for assign() and add_note() — no deadlocks, no torn writes."""
import sys
import threading

import flows
import minihttp as requests
from config import ADMIN, ADMIN2, BASE, MERCHANT, Checker, H, login

check = Checker()

atok = login(*ADMIN)
a2tok = login(*ADMIN2)

q = requests.get(f"{BASE}/api/admin/bookings/queue?page_size=1", headers=H(atok)).json()
if not q["items"]:
    print("(queue empty — building a booking to hammer)")
    flows.make_booking(login(*MERCHANT), atok, upto="approved", label="M1 concurrency")
    q = requests.get(f"{BASE}/api/admin/bookings/queue?page_size=1", headers=H(atok)).json()
rid = q["items"][0]["id"]
ops = requests.get(f"{BASE}/api/admin/bookings/operators", headers=H(atok)).json()
print(f"booking {rid}, operators: {[(o['id'], o['full_name']) for o in ops]}")

# --- 8 simultaneous assigns alternating between two operators -------------
results = []
lock = threading.Lock()


def hammer(i):
    op = ops[i % len(ops)]["id"]
    tok = atok if i % 2 == 0 else a2tok
    r = requests.post(f"{BASE}/api/admin/bookings/{rid}/assign", headers=H(tok), json={"operator_id": op})
    with lock:
        results.append((r.status_code, r.json().get("assigned_admin") if r.status_code == 200 else r.text[:80]))


threads = [threading.Thread(target=hammer, args=(i,)) for i in range(8)]
[t.start() for t in threads]
[t.join() for t in threads]

codes = [c for c, _ in results]
print(f"assign status codes: {sorted(codes)}")
check("8 simultaneous assigns all succeed (no deadlock, no 500)",
      all(c == 200 for c in codes), str(sorted(codes)))

final = requests.get(f"{BASE}/api/admin/bookings/queue?search={q['items'][0]['request_number']}",
                     headers=H(atok)).json()["items"][0]
print(f"final assignee: {final['assigned_admin']} ({final['assigned_to']})")
check("the winning assignee is one of the contenders",
      final["assigned_admin"] in [o["id"] for o in ops], str(final["assigned_admin"]))

# --- 10 simultaneous notes must all persist, none lost --------------------
note_ids = []


def note(i):
    r = requests.post(f"{BASE}/api/admin/bookings/{rid}/notes", headers=H(atok),
                      json={"body": f"concurrent note {i}"})
    if r.status_code == 201:
        with lock:
            note_ids.append(r.json()["id"])


threads = [threading.Thread(target=note, args=(i,)) for i in range(10)]
[t.start() for t in threads]
[t.join() for t in threads]

listed = requests.get(f"{BASE}/api/admin/bookings/{rid}/notes", headers=H(atok)).json()
listed_ids = {n["id"] for n in listed}
check("all 10 concurrent notes were created", len(note_ids) == 10, f"{len(note_ids)}/10")
check("every concurrent note is present in the listing", set(note_ids) <= listed_ids)
check("no two concurrent notes share an id", len(set(note_ids)) == len(note_ids))

for nid in note_ids:
    requests.delete(f"{BASE}/api/admin/bookings/notes/{nid}", headers=H(atok))
print("cleaned up concurrent test notes")

sys.exit(check.report())
