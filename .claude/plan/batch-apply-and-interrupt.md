# Implementation Plan: Batch Apply Performance + Interrupt Button

## Overview

The AI categorizer's "Apply All" phase sends 2N sequential HTTP requests (N GET + N PUT) to Firefly III, causing 868+ network round-trips that take minutes and flood the browser with SSE events. This plan introduces a new Firefly III bulk categorize API endpoint, batched apply logic in the categorizer, throttled SSE events, and an interrupt button for all long-running operations.

## Problems Addressed

1. **2N sequential HTTP requests** -- `BatchAnalyzer.apply()` loops proposals one-by-one: GET then PUT per transaction
2. **SSE event flood** -- 868 progress events trigger 868 Alpine.js re-renders, freezing the browser
3. **No bulk API** -- Firefly III has no API endpoint for batch category+tag updates
4. **No interrupt** -- Apply, Retry, and Analyze operations cannot be cancelled mid-flight

## Architecture Changes

| Change | Module | File(s) |
|--------|--------|---------|
| New bulk categorize API endpoint | firefly-iii | New controller, request, route registration |
| New `bulkCategorize()` method | categorizer | `src/FireflyService.js` |
| Chunked apply with abort support | categorizer | `src/BatchAnalyzer.js` |
| Abort signal threading through analyze/retry | categorizer | `src/BatchAnalyzer.js` |
| SSE abort detection in routes | categorizer | `src/routes/batch.js` |
| Throttled SSE progress | categorizer | `src/routes/batch.js` |
| Interrupt button for apply/retry | categorizer | `frontend/src/stores/batch.js`, `public/index.html` |
| AbortSignal support in mapConcurrent | categorizer | `src/util.js` |
| SSE `cancelled` event handling | categorizer | `frontend/src/lib/sse.js` |

## Design Decisions (from architect review)

1. **Cancellation is client-side only**: When the user clicks Cancel, the frontend aborts the fetch. The `sse.js` client converts the `AbortError` to `new Error("Cancelled")`. The server detects the closed connection via `req.on("close")` and stops processing, but does NOT try to write back to the closed response. The `cancelled` state is determined entirely by the client.

2. **Optimistic bulk transaction with individual fallback**: The bulk endpoint FIRST wraps all updates in a single `DB::transaction()`. If every update succeeds, COMMIT (fast path: one transaction for 50 updates, minimal lock time). If ANY update throws, ROLLBACK the entire batch and fall back to per-item processing: each of the 50 items gets its own `DB::transaction()`, succeeding or failing independently. The response reports partial success (applied=48, failed=2, errors=[details]). This gives the best of both worlds: maximum throughput on the happy path, precise failure isolation on the sad path.

3. **Single `JournalUpdateService::update()` call per journal**: Category and tag are combined into one `setData(['category_name' => $catName, 'tags' => $mergedTags])` call, avoiding two service instantiations per journal.

4. **No separate `mapConcurrentAbortable`**: The existing `mapConcurrent` is extended with an optional `signal` parameter to avoid code duplication.

5. **Tag append semantics**: `updateTags` does REPLACE, not append. The controller must fetch existing tags first via `$journal->tags->pluck('tag')->toArray()`, merge with the new tag, then call `updateTags` with the merged array. Pattern: `BulkController::updateJournalTags` lines 166-170.

## Implementation Steps

### Phase 1: Firefly III Bulk Categorize Endpoint

#### Step 1.1: Create the FormRequest class

- [x] **Create file**: `/mnt/g/REPOS/firefly/firefly-iii/app/Api/V1/Requests/Data/Bulk/CategorizeRequest.php`
- **Action**: Create a new FormRequest that validates:
  - `transactions` -- required array, max 100 items
  - `transactions.*.transaction_group_id` -- required, integer, exists in `transaction_groups`
  - `transactions.*.category_name` -- required, string, max 255
  - `transactions.*.tag` -- optional, string, max 255 (default: "AI categorized")
- **Pattern**: Follow the existing `TransactionRequest.php` in the same namespace. Use `ChecksLogin` and `ConvertsDataTypes` traits.
- **Validation rules**:
  ```php
  public function rules(): array
  {
      return [
          'transactions'                          => ['required', 'array', 'min:1', 'max:100'],
          'transactions.*.transaction_group_id'   => ['required', 'integer'],
          'transactions.*.category_name'          => ['required', 'string', 'max:255'],
          'transactions.*.tag'                    => ['sometimes', 'string', 'max:255'],
      ];
  }
  ```
- **Dependencies**: None
- **Risk**: Low

#### Step 1.2: Create the BulkCategorizeController

- [x] **Create file**: `/mnt/g/REPOS/firefly/firefly-iii/app/Api/V1/Controllers/Data/Bulk/BulkCategorizeController.php`
- **Action**: Create a controller with a single `categorize(CategorizeRequest $request): JsonResponse` method.
- **Namespace**: `FireflyIII\Api\V1\Controllers\Data\Bulk`
- **Extends**: `FireflyIII\Api\V1\Controllers\Controller`
- **Logic**:
  1. **CRITICAL: Auth + repository init** (pattern: `TransactionController` lines 51-59):
     - In the middleware closure, call `$this->validateUserGroup($request)` to set `$this->user` and `$this->userGroup`
     - Call `$this->journalRepository->setUser($this->user)` and `$this->journalRepository->setUserGroup($this->userGroup)`
     - Do the same for `CategoryRepositoryInterface` if used
     - Without this, `$this->user` is null and all queries will throw
  2. Set `$acceptedRoles = [UserRoleEnum::MANAGE_TRANSACTIONS]`
  3. **Optimistic bulk -> individual fallback**: FIRST, wrap ALL items in a single `DB::transaction()`. If all succeed -> COMMIT (fast path). If any update throws -> ROLLBACK the entire batch, then fall back to per-item processing: loop through each item individually, each wrapped in its own `DB::transaction()`, logging which specific items failed. Return partial success with applied/failed counts and error details.
  4. For each item in `$request->input('transactions')`:
     a. **CRITICAL: User-scoped lookup**: Find `TransactionGroup` via `$this->userGroup->transactionGroups()->find($groupId)` -- NOT `TransactionGroup::find()` (authorization bypass)
     b. Skip if not found (record in `$failed` array with error message)
     c. Get all `TransactionJournal` records from the group
     d. For each journal, combine category + tag in a single `JournalUpdateService` call:
        - Build data array: `['category_name' => $categoryName]`
        - **Tag append** (pattern: `BulkController::updateJournalTags` lines 166-170):
          Fetch existing tags: `$existingTags = $journal->tags->pluck('tag')->toArray();`
          Merge: `$data['tags'] = array_unique(array_merge($existingTags, [$tagName]));`
        - Call `$this->repository->update($journal, $data)` -- single service call for both category + tag
     e. Accumulate `TransactionGroupEventObject` for batch event firing
  5. Return JSON response: `{ "applied": N, "failed": N, "errors": [...] }`
  6. **Event firing**: After the loop, fire a single `UpdatedSingleTransactionGroup` event with ALL accumulated `TransactionGroupEventObjects`. Do NOT fire per-transaction. Skip webhooks entirely (the bulk endpoint is the webhook consumer, not trigger).
  7. **Pre-implementation check**: Grep for `event(` and `dispatch(` inside `JournalUpdateService::update()` and its trait methods (`storeTags`, `storeCategory`) to confirm no internal events are fired. If they are, the bulk endpoint must suppress them.
- **Pattern reference**: `BulkController@update` at `/mnt/g/REPOS/firefly/firefly-iii/app/Http/Controllers/Transaction/BulkController.php` lines 97-137
- **Dependencies**: Step 1.1
- **Risk**: Medium -- must ensure `updateCategory` works correctly when called without a full `JournalUpdateService::update()` cycle.

#### Step 1.3: Register the route

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii/routes/api.php`
- **Action**: Inside the existing bulk route group (lines 208-218), add:
  ```php
  Route::post('categorize', ['uses' => 'BulkCategorizeController@categorize', 'as' => 'categorize']);
  ```
  This registers the endpoint at `POST /api/v1/data/bulk/categorize`.
- **Dependencies**: Steps 1.1, 1.2
- **Risk**: Low

#### Step 1.4: Verify the endpoint

- [x] **Verification**: From the Firefly III container, run:
  ```bash
  docker compose exec app php artisan route:clear
  docker compose exec app php artisan route:list --path=bulk/categorize
  ```
  Confirm the route appears. Then test with curl:
  ```bash
  docker compose exec app curl -s -X POST http://localhost:8080/api/v1/data/bulk/categorize \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"transactions":[{"transaction_group_id":1,"category_name":"Test","tag":"AI categorized"}]}'
  ```
  Expect 200 with `{"applied":1,"failed":0,"errors":[]}` or 422 validation error.
- **Dependencies**: Steps 1.1-1.3
- **Risk**: Low

### Phase 2: Categorizer Backend -- Bulk Apply + Abort

#### Step 2.1: Add `bulkCategorize()` to FireflyService

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/src/FireflyService.js`
- **Action**: Add a new method:
  ```javascript
  async bulkCategorize(items) {
      const personalToken = this.#configStore.getValue("FIREFLY_PERSONAL_TOKEN", { required: true });
      const response = await fetch(`${this.#BASE_URL}/api/v1/data/bulk/categorize`, {
          method: "POST",
          headers: {
              Authorization: `Bearer ${personalToken}`,
              "Content-Type": "application/json",
          },
          body: JSON.stringify({
              transactions: items.map(it => ({
                  transaction_group_id: parseInt(it.transactionGroupId, 10),
                  category_name: it.categoryName,
                  tag: it.tag,
              })),
          }),
      });
      if (!response.ok) {
          if (response.status === 404) return null; // endpoint not available -- fallback
          throw new FireflyException(response.status, response, await response.text());
      }
      return await response.json();
  }
  ```
- Returns `null` on 404 for backward compatibility detection.
- **Dependencies**: Phase 1 complete
- **Risk**: Low

#### Step 2.2: Add `checkBulkCategorizeSupport()` to FireflyService

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/src/FireflyService.js`
- **Action**: Add a method that probes whether the bulk endpoint exists:
  ```javascript
  async checkBulkCategorizeSupport() {
      const personalToken = this.#configStore.getValue("FIREFLY_PERSONAL_TOKEN", { required: true });
      try {
          const response = await fetch(`${this.#BASE_URL}/api/v1/data/bulk/categorize`, {
              method: "POST",
              headers: {
                  Authorization: `Bearer ${personalToken}`,
                  "Content-Type": "application/json",
              },
              body: JSON.stringify({ transactions: [] }),
          });
          return response.status !== 404; // 422 = exists but validation failed
      } catch { return false; }
  }
  ```
- One-time probe at apply start. Cache result for the session.
- **Dependencies**: Step 2.1
- **Risk**: Low

#### Step 2.3: Extend `mapConcurrent()` with optional abort signal

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/src/util.js`
- **Action**: Add optional `signal` parameter to the existing `mapConcurrent` (do NOT create a separate function -- avoids code duplication):
  ```javascript
  export async function mapConcurrent(items, concurrency, fn, signal = null) {
      const results = new Array(items.length);
      let nextIndex = 0;
      async function worker() {
          while (nextIndex < items.length) {
              if (signal?.aborted) break;
              const i = nextIndex++;
              results[i] = await fn(items[i], i);
          }
      }
      await Promise.all(
          Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
      );
      if (signal?.aborted) {
          const err = new Error("Operation cancelled");
          err.name = "AbortError";
          throw err;
      }
      return results;
  }
  ```
  **Note**: Up to `concurrency` extra items may complete after abort (cooperative cancellation -- each worker finishes its current `await fn()` before checking the signal). This is acceptable and should be documented in a code comment.
- **Dependencies**: None
- **Risk**: Low

#### Step 2.4: Rewrite `BatchAnalyzer.apply()` for bulk + abort

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/src/BatchAnalyzer.js`
- **Action**: Rewrite the `apply()` method (currently lines 360-418):
  1. **Add `signal` parameter**: `async apply(approvedProposals, newCategoriesToCreate = [], onProgress = null, signal = null)`
  2. **Category creation**: Keep as-is but check `signal?.aborted` before each iteration.
  3. **Probe bulk support**: Call `this.#fireflyService.checkBulkCategorizeSupport()`. Cache result.
  4. **If bulk supported**:
     a. Filter proposals (has `proposedCategory`, not already processed).
     b. Chunk into groups of 50 (headroom under 100-item API limit).
     c. Per chunk: check `signal?.aborted`, build `[{ transactionGroupId, categoryName, tag }]`, call `bulkCategorize(items)`.
     d. On success: update jobList + merchantMemory for each proposal in chunk.
     e. Emit ONE progress event per chunk.
  5. **If bulk NOT supported (fallback)**: Keep current per-transaction logic (including the GET call for tag data) with `signal?.aborted` check and emit progress every 10 transactions. The GET is still needed in legacy mode to fetch existing tags for append.
  6. Return result with `{ mode: "bulk" | "legacy" }`.
- **Key change**: GET call (`getTransaction`) eliminated entirely in bulk mode -- the server handles tag fetching/appending internally.
- **Field mapping**: `{ transactionGroupId: proposal.fireflyTxnId, categoryName: proposal.proposedCategory, tag: tagValue }`
- **Dependencies**: Steps 2.1, 2.2, 2.3
- **Risk**: Medium

#### Step 2.5: Thread abort signal through `analyze()` and `retryUnmatched()`

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/src/BatchAnalyzer.js`
- **Action**:
  1. Add `signal` to `analyze()`: check `signal?.aborted` before each seed batch, use `mapConcurrentAbortable` for parallel batches.
  2. Add `signal` to `retryUnmatched()`: check `signal?.aborted` before each retry batch.
  3. When aborted, return partial results (not throw) so UI can display what was done.
- **Dependencies**: Step 2.3
- **Risk**: Low

#### Step 2.6: Wire abort signals in SSE route handlers

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/src/routes/batch.js`
- **Action**: In each SSE endpoint (`/batch/analyze`, `/batch/apply`, `/batch/retry-unmatched`):
  1. Create `AbortController` at handler start.
  2. Listen `req.on("close", () => controller.abort())` -- this fires when the client disconnects (user aborts the fetch or navigates away).
  3. Pass `controller.signal` to `batchAnalyzer` method.
  4. Catch `AbortError` in the try/catch -- but do NOT try to write back to the response (connection is already closed). The server's role is only to stop doing work. Log the cancellation.
  5. **Cancellation detection is client-side**: The frontend `AbortController.abort()` causes the fetch to throw `AbortError`, which `sse.js` converts to `new Error("Cancelled")`. No server-to-client SSE event needed.
- **Dependencies**: Steps 2.4, 2.5
- **Risk**: Low

#### Step 2.7: Throttle SSE progress events

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/src/routes/batch.js`
- **Action**: Replace raw `send("progress", progress)` with throttled wrapper (max 1 event per 500ms). Only throttle "progress" events -- "error" and "complete" always pass through immediately.
- **Flush ordering**: Before sending "complete", call `flush()` synchronously to emit the last buffered progress event. This ensures the final progress state (100%) is always received before the completion event. The flush and complete write happen in the same synchronous block, preventing any race between them.
- **Dependencies**: None
- **Risk**: Low

### Phase 3: Frontend -- Interrupt Button + UX

#### Step 3.0: Handle `Cancelled` error in SSE client

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/frontend/src/lib/sse.js`
- **Action**: The SSE client already converts `AbortError` to `new Error("Cancelled")` at lines 51 and 56. No new SSE event type needed. Verify that the catch blocks in `applyAll()` and `retryUnmatched()` can distinguish "Cancelled" from real errors by checking `err.message === "Cancelled"`.
- **Dependencies**: None
- **Risk**: Low

#### Step 3.1: Add AbortController to `applyAll()` and `retryUnmatched()`

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/frontend/src/stores/batch.js`
- **Action**: The `streamSSE` function already supports a `signal` parameter (sse.js line 3). Only the store methods need to create and pass an AbortController.
  1. In `applyAll()`: Create `this._abortController = new AbortController()`, pass `{ signal: this._abortController.signal, onProgress }` to `streamSSE`.
  2. In `retryUnmatched()`: Same pattern.
  3. On catch: if `err.message === "Cancelled"`, set `step = "review"` (not "done"), show toast "Cancelled. X of Y applied so far."
  4. Set `this._abortController = null` in `finally`.
- **Dependencies**: Step 3.0, Phase 2 complete
- **Risk**: Low

#### Step 3.2: Rename `cancelAnalysis()` to `cancelOperation()`

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/frontend/src/stores/batch.js`
- **Action**: Rename the existing `cancelAnalysis()` (line 127) to `cancelOperation()`. The logic is identical -- abort the controller and set to null. This avoids duplicating the cancel function. Update the existing analyze cancel button in `public/index.html` from `$store.batch.cancelAnalysis()` to `$store.batch.cancelOperation()`.
- **Dependencies**: Step 3.1
- **Risk**: Low

#### Step 3.3: Add Cancel/Interrupt buttons to the UI

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/public/index.html`
- **Action**: Add Cancel buttons next to Apply All and Retry buttons, visible only during active operation:
  ```html
  <button x-show="$store.batch.step === 'applying'" @click="$store.batch.cancelOperation()">Cancel</button>
  <button x-show="$store.batch.step === 'retrying'" @click="$store.batch.cancelOperation()">Cancel</button>
  ```
  Existing analyze cancel button already exists -- verify it works.
- **Dependencies**: Step 3.2
- **Risk**: Low

#### Step 3.4: Handle partial apply on cancel

- [x] **Modify file**: `/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/frontend/src/stores/batch.js`
- **Action**: After cancellation, return to "review" step. Re-clicking "Apply All" is safe because `apply()` skips `isAlreadyProcessed()` entries.
- **Dependencies**: Steps 3.1-3.3
- **Risk**: Medium -- partial state management needs care

### Phase 4: Build, Test, and Verify

#### Step 4.1: Build frontend

- [x] **Run**: `cd frontend && npm run build`
- **Dependencies**: Phase 3 complete

#### Step 4.2: Test backward compatibility (bulk endpoint absent)

- [x] **Verification**: Test against unmodified Firefly III. Verify fallback to per-transaction PUT with console log.
- **Dependencies**: Phases 1-3

#### Step 4.3: Test bulk mode end-to-end

- [x] **Verification**: Deploy updated Firefly III + categorizer. Create 50+ uncategorized transactions. Verify:
  - Console shows "Using bulk categorize endpoint"
  - Progress updates per chunk, not per transaction
  - Browser remains responsive
  - Correct categories and tags applied
  - Cancel works mid-flight
  - Resume after cancel skips already-processed
- **Dependencies**: Phases 1-3

#### Step 4.4: Test SSE throttling

- [x] **Verification**: Open DevTools > Network > EventSource. Run "Analyze" on 200+ transactions. SSE events should be ~2/sec, not 1 per transaction.
- **Dependencies**: Step 2.7

#### Step 4.5: Verify route cache and autoloader

- [x] **Verification**: Clear caches and verify bulk route appears:
  ```bash
  docker compose exec app php artisan route:clear && config:clear && cache:clear
  docker compose exec app composer dump-autoload
  docker compose exec app php artisan route:list --path=bulk
  ```
- **Dependencies**: Phase 1

## Data Flow: Before vs After

### Current (per-transaction):
```
For each proposal (868x):
  Categorizer -> GET /api/v1/transactions/{id} -> Firefly
  Categorizer -> PUT /api/v1/transactions/{id} -> Firefly
  Firefly -> webhook -> Categorizer
Total: 868 GETs + 868 PUTs + 868 webhooks = 2,604 HTTP requests
SSE events to browser: 868
```

### New (bulk):
```
For each chunk of 50 (~18 chunks):
  Categorizer -> POST /api/v1/data/bulk/categorize -> Firefly (optimistic bulk txn; individual fallback on failure)
Total: 18 POSTs, 0 per-txn webhooks
SSE events to browser: ~18 (throttled to max 2/sec)
```

## File Change Summary

### Firefly III (`/mnt/g/REPOS/firefly/firefly-iii/`)

| Action | File |
|--------|------|
| CREATE | `app/Api/V1/Requests/Data/Bulk/CategorizeRequest.php` |
| CREATE | `app/Api/V1/Controllers/Data/Bulk/BulkCategorizeController.php` |
| MODIFY | `routes/api.php` (add 1 route line inside existing bulk group) |

### Categorizer (`/mnt/g/REPOS/firefly/firefly-iii-ai-categorize/`)

| Action | File |
|--------|------|
| MODIFY | `src/FireflyService.js` (add `bulkCategorize`, `checkBulkCategorizeSupport`) |
| MODIFY | `src/util.js` (extend `mapConcurrent` with optional `signal` param) |
| MODIFY | `src/BatchAnalyzer.js` (rewrite `apply`, add signal to `analyze` and `retryUnmatched`) |
| MODIFY | `src/routes/batch.js` (abort signals, SSE throttling) |
| MODIFY | `frontend/src/lib/sse.js` (verify `Cancelled` error handling) |
| MODIFY | `frontend/src/stores/batch.js` (abort controllers, rename `cancelAnalysis` to `cancelOperation`) |
| MODIFY | `public/index.html` (cancel buttons for apply/retry, update analyze cancel ref) |

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Bulk endpoint on older Firefly III | High | Probe once at apply start; fall back to per-txn PUT if 404 |
| Auth bypass via `TransactionGroup::find()` | High | MUST use `$this->userGroup->transactionGroups()->find($id)` |
| Tag replacement instead of append | High | Fetch existing tags first, merge, then call `updateTags` |
| `JournalUpdateService` firing internal events | Medium | Grep for `event(`/`dispatch(` in service traits before impl |
| Partial apply on cancel | Medium | `apply()` skips `isAlreadyProcessed()` on re-run; UI returns to review |
| SSE throttle hides errors | Medium | Only throttle "progress"; "error"/"complete" always pass through |
| Up to N=concurrency extra items after abort | Low | Cooperative cancellation; documented behavior |
| Probe sends empty array triggering 422 logs | Low | Acceptable; add code comment explaining why |

## Success Criteria

- [ ] `POST /api/v1/data/bulk/categorize` returns 200 with correct `applied` count
- [ ] 868 transactions categorized in <30 seconds (vs. current ~10 minutes)
- [ ] Browser DevTools shows <30 SSE events for 868 transactions (vs. 868)
- [ ] Browser remains responsive throughout apply
- [ ] Cancel button stops analyze/retry/apply within 2 seconds
- [ ] Cancelled apply can be resumed by clicking "Apply All" again
- [ ] Fallback to per-transaction PUT works when bulk endpoint returns 404
- [ ] All transactions receive correct category and "AI categorized" tag
- [ ] No duplicate webhook storms
