# User Payout Management System — LLD

A Low-Level Design + working implementation of an affiliate payout system:
**Advance Payout (10%) → Reconciliation → Final Payout → Withdrawal (24h
throttle) → Failed Payout Recovery.**

Built in **Node.js / Express**, no external DB required to run (in-memory
repositories behind a repository interface — see [Design Decisions](#design-decisions)).
A full **PostgreSQL schema** is included at [`schema.sql`](./schema.sql) as
the reference relational design.

---

## Quick start

```bash
npm install
npm test        # runs the full functional test suite (20 checks) — also doubles as a live demo
npm start        # starts the HTTP server on :3000
```

`npm test` reproduces the assignment's worked example end-to-end and asserts
`Final Payout = ₹68`, plus Case 1 / Case 2, the 24h withdrawal throttle, and
Failed Payout Recovery.

---

## 1. Problem Recap

1. A **sale** enters the system `pending`.
2. An **Advance Payout job** pays the user 10% of every pending sale's
   earnings, exactly once per sale, even if the job is re-run.
3. An **admin reconciles** each sale to `approved` or `rejected`.
   - Approved → user gets `earning − advancePaid`.
   - Rejected → user is charged back `−advancePaid` (they weren't entitled to
     the advance).
4. A user can **withdraw** their accumulated final payout, **once every 24
   hours**.
5. If a withdrawal later **fails / is cancelled / is rejected**, the amount
   is credited back and the user can **immediately** try to withdraw it
   again (bypassing the 24h throttle for that recovered amount).

---

## 2. Entities & Relationships

```
 User ──1───< Sale >───1── Brand
   │                          
   │ 1                        
   ▼ N                        
 WalletTransaction  (append-only ledger; sale_id / withdrawal_id optional FKs)
   ▲ N
   │ 1
 Withdrawal ──1── User
```

| Entity | Purpose |
|---|---|
| **User** | An affiliate whose sales/payouts we track. |
| **Brand** | The merchant a sale belongs to. |
| **Sale** | One affiliate sale. Tracks its own status, advance-paid amount/timestamp, and (once reconciled) its final adjustment. |
| **WalletTransaction** | Append-only, immutable ledger row. **Single source of truth** for a user's withdrawable balance — the balance is `SUM(amount)` over a user's rows, never a mutable counter. |
| **Withdrawal** | One withdrawal attempt/request, with a status lifecycle (`initiated → success \| failed \| cancelled \| rejected`). |

Full DDL with indexes and constraints: [`schema.sql`](./schema.sql).

---

## 3. Class / Module Design

```
src/
├── models/                 # Plain data classes (entity shape + small invariants)
│   ├── Sale.js              # SaleStatus enum, isEligibleForAdvance, isReconciled
│   ├── User.js
│   ├── WalletTransaction.js # TransactionType enum
│   └── Withdrawal.js        # WithdrawalStatus enum, RECOVERABLE_STATUSES set
│
├── repositories/            # Data access, swappable for a real DB (see schema.sql)
│   └── InMemoryRepository.js
│
├── services/                # All business logic lives here
│   ├── AdvancePayoutService.js    # Question 1, rule 1
│   ├── ReconciliationService.js   # Question 1, rule 2 (Case 1 / Case 2)
│   ├── WalletService.js           # balance / statement reads
│   └── WithdrawalService.js       # Question 1 rule 3 (24h) + Question 2 (recovery)
│
├── controllers/routes.js    # Express routes — thin, delegates to services
├── container.js             # Dependency-injection wiring (repos → services)
├── app.js                   # createApp() factory
└── server.js                # process entrypoint
```

**Why this split:** controllers know nothing about business rules; services
know nothing about HTTP; repositories know nothing about business rules
either — they just persist/query. This means the entire rule set (advance
idempotency, reconciliation math, throttle, recovery) is unit-testable
without spinning up Express at all (`tests/demo.js` does exactly that,
calling services directly).

---

## 4. Core Business Logic

### 4.1 Advance Payout (idempotent)

```js
// Sale.isEligibleForAdvance
status === 'pending' && advancePaidAt === null
```

The job only ever selects sales matching that predicate, and flips
`advancePaidAt` in the same synchronous step it writes the ledger row. Node's
single-threaded event loop makes this check-then-set atomic in memory; the
SQL equivalent is a single conditional `UPDATE ... WHERE status='pending' AND
advance_paid_at IS NULL` (see `schema.sql`), which gets the same atomicity
from the database engine even under concurrent job workers. **Re-running the
job is always safe — a sale can never be advanced twice.**

### 4.2 Reconciliation → Final Payout

```js
adjustment =
  status === 'approved' ? (earning - advancePaid)
: status === 'rejected' ? (-advancePaid)
```

Written once as a `RECONCILIATION_ADJUSTMENT` ledger row.
`Sale.isReconciled` (`status !== 'pending'`) guards against reconciling the
same sale twice.

### 4.3 Withdrawable balance

**Design decision:** the Advance Payout is modeled as money that is
*transferred directly to the user immediately* — it's a cash advance, not
something sitting in a "withdraw later" pool. So `ADVANCE_PAYOUT` ledger rows
are kept for audit/history but are **excluded** from the withdrawable-balance
sum. Only `RECONCILIATION_ADJUSTMENT`, `WITHDRAWAL`, and
`WITHDRAWAL_REVERSAL` rows count. This is what makes the worked example add
up: ₹12 advance goes out immediately, and the withdrawable balance after
reconciliation is exactly ₹68 (`-4 + 36 + 36`), not ₹68 + ₹12.

### 4.4 Withdrawal throttle (one every 24h)

A user is blocked from withdrawing only while their **most recent**
withdrawal is still "live": requested within the last 24h **and** not in a
recoverable terminal state. A withdrawal that failed/was cancelled/was
rejected never reached the user, so per the Failed Payout Recovery
requirement it must **not** count against the throttle — the user can retry
immediately.

### 4.5 Failed Payout Recovery (Question 2)

`WithdrawalService.updateStatus()` simulates a payment-gateway
webhook/callback. If the new status is `failed`, `cancelled`, or `rejected`,
a `WITHDRAWAL_REVERSAL` ledger row credits the amount straight back, and —
because §4.4's throttle check ignores recoverable withdrawals — the user can
call `/withdraw` again immediately for the same (or any) amount up to their
restored balance.

---

## 5. API Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/sales` | `{ userId, brand, earning }` | Create a pending sale. Auto-creates the user/brand if new. |
| `GET` | `/sales?userId=` | – | List sales, optionally filtered by user. |
| `POST` | `/sales/:id/reconcile` | `{ status: "approved" \| "rejected" }` | Admin reconciles one sale; computes final adjustment. |
| `POST` | `/jobs/advance-payout` | `{ userId }` | Runs the advance-payout job for a user (idempotent; call as often as you like). |
| `GET` | `/users/:userId/wallet` | – | Current withdrawable balance. |
| `GET` | `/users/:userId/transactions` | – | Full ledger statement for a user. |
| `POST` | `/users/:userId/withdraw` | `{ amount? }` | Initiates a withdrawal (defaults to full balance). 400s if throttled or over-balance. |
| `POST` | `/withdrawals/:id/status` | `{ status: "success" \| "failed" \| "cancelled" \| "rejected" }` | Simulates a payment-gateway callback; triggers recovery on a failure status. |

All error responses: `{ "error": "...", "code": "..." }` with an appropriate
HTTP status (`400` business-rule violation, `404` not found, `500`
unexpected).

### Example: reproducing the assignment's worked example

```bash
curl -X POST localhost:3000/sales -d '{"userId":"john_doe","brand":"brand_1","earning":40}' -H 'Content-Type: application/json'
curl -X POST localhost:3000/sales -d '{"userId":"john_doe","brand":"brand_1","earning":40}' -H 'Content-Type: application/json'
curl -X POST localhost:3000/sales -d '{"userId":"john_doe","brand":"brand_1","earning":40}' -H 'Content-Type: application/json'

curl -X POST localhost:3000/jobs/advance-payout -d '{"userId":"john_doe"}' -H 'Content-Type: application/json'
# totalAdvancePaid: 12

curl -X POST localhost:3000/sales/<id1>/reconcile -d '{"status":"rejected"}' -H 'Content-Type: application/json'
curl -X POST localhost:3000/sales/<id2>/reconcile -d '{"status":"approved"}' -H 'Content-Type: application/json'
curl -X POST localhost:3000/sales/<id3>/reconcile -d '{"status":"approved"}' -H 'Content-Type: application/json'

curl localhost:3000/users/john_doe/wallet
# { "withdrawableBalance": 68 }
```

---

## 6. Edge Cases & Failure Scenarios Handled

| Scenario | Behavior |
|---|---|
| Advance payout job re-run / run concurrently | No-op for already-advanced sales (idempotency guard on `advancePaidAt`). |
| Reconcile a sale twice | Rejected with `ALREADY_RECONCILED`. |
| Reconcile a non-existent sale | Rejected with `NOT_FOUND` (404). |
| Reconcile to an invalid status (e.g. `"pending"`) | Rejected with `INVALID_STATUS`. |
| Sale approved/rejected before the advance job ever ran | `advancePaid` is 0, so the full earning (or 0 adjustment) is correctly used — no crash, no negative-advance bug. |
| Withdraw more than available balance | Rejected with `INSUFFICIENT_BALANCE`. |
| Withdraw ₹0 or negative | Rejected with `INVALID_AMOUNT`. |
| Withdraw twice within 24h | Second attempt rejected with `THROTTLED` (message includes retry-after minutes). |
| Withdrawal fails/cancelled/rejected | Amount reversed to withdrawable balance; next withdrawal attempt is **not** throttled by the failed one. |
| Update status on a withdrawal already in a terminal state | Rejected with `ALREADY_SETTLED` — prevents double-crediting a reversal. |
| Rejected sale with more advance than a later-approved sale's contribution | Balance can legitimately go negative (user owes money); a further withdrawal is simply blocked by `INSUFFICIENT_BALANCE` until it's positive again — no special-casing needed since the ledger is signed. |
| Floating point rounding (10% of ₹33, etc.) | All monetary math is rounded to 2 decimals via a single `round2()` helper used everywhere money is computed, avoiding drift across many small transactions. |

---

## 7. Design Decisions & Trade-offs

- **Append-only ledger over a mutable balance column.** Slightly more
  compute per balance read (`SUM` over rows) but the balance can never drift
  from its audit trail, every credit/debit is independently inspectable, and
  reversals become a normal insert instead of a special "undo" code path.
  At scale this would be paired with a materialized/cached running balance
  updated transactionally alongside each ledger insert.

- **Advance payout excluded from the withdrawable ledger.** Chosen because
  the problem statement describes the advance as *transferred* to the user
  already, distinct from the later "final payout" that the user withdraws.
  An alternative reading — where the advance itself must be "withdrawn" via
  the same throttled endpoint — is plausible too; the code isolates this
  choice to one filter in `WalletTransactionRepository.balanceOf()`, so it's
  a one-line change if the intended semantics differ.

- **In-memory repositories behind a repository interface, real Postgres
  schema provided separately.** Keeps the assignment trivially runnable
  (`npm install && npm test`, no DB provisioning) while still demonstrating
  the intended relational schema, indexes, and the exact `WHERE` clauses
  that would give the same atomicity guarantees in production. Swapping
  `InMemoryRepository.js` for a Postgres-backed implementation only touches
  that one file — services and controllers are unaffected.

- **24h throttle scoped to "most recent withdrawal" rather than "count of
  withdrawals in the last 24h."** Matches "one withdrawal every 24 hours"
  literally (a rolling window keyed off the last request), and composes
  cleanly with recovery: a recoverable withdrawal simply doesn't count as
  "the most recent live one."

- **Idempotency via a flag + guard on the entity, not a queue/lock
  system.** Sufficient for a single-process Node service and mirrors what a
  conditional `UPDATE` gives you in a real DB; a distributed multi-worker
  setup would additionally want the job to claim a batch via
  `SELECT ... FOR UPDATE SKIP LOCKED` or a job queue with dedup keys.

- **Money represented as JS numbers, rounded to 2dp via a shared helper.**
  Fine for an assignment-scale system; a production system would use
  integer minor units (paise) or a decimal library to eliminate all
  floating-point risk.

---

## 8. Testing

```bash
npm test
```

`tests/demo.js` exercises the service layer directly (no HTTP) and asserts:
1. The assignment's exact worked example → **₹68** final payout.
2. Case 1 (approved) and Case 2 (rejected) individually, matching the
   assignment's ₹27 and −₹5 examples.
3. Advance-job idempotency on re-run.
4. 24h withdrawal throttle, including a fake injectable clock to test the
   boundary without sleeping in real time.
5. Failed Payout Recovery unblocking an immediate re-withdrawal.
6. Double-reconciliation, unknown-sale, over-balance, and zero-advance edge
   cases.

20/20 checks pass.
