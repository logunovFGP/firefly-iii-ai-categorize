# Architecture Review: firefly-iii-ai-categorize

**Date**: 2026-03-29
**Reviewer**: Architecture Agent (Opus 4.6)
**Scope**: Full codebase review of all 16 source files, 1 HTML frontend, Dockerfile, plus TRC20 provider cross-reference

---

## Executive Summary

The firefly-iii-ai-categorize project is a well-structured Node.js service that provides AI-powered transaction categorization for Firefly III. The architecture follows a clean 3-stage classification pipeline (keyword rules, merchant memory, AI), with a two-pass batch workflow (analyze then apply) and real-time webhook processing.

**Overall assessment**: Solid foundation with good separation of concerns. The codebase is small (~1,600 lines across 16 JS files + ~1,100 lines HTML/CSS/JS) and internally consistent. The most significant gap is the complete absence of cryptocurrency transaction handling -- crypto transactions from the TRC20 importer reach the AI stage unnecessarily, wasting API calls on unclassifiable wallet-address data. There are also several instances of duplicated logic, missing security hardening, no test framework, and no graceful shutdown.

**Lines of code** (approximate):
- `src/` JS: ~1,600 lines across 16 files
- `public/index.html`: ~1,088 lines (single-file UI)
- Total: ~2,700 lines

---

## Architecture Diagram

```
                                    Firefly III
                                   (Laravel App)
                                   /           \
                                  /             \
                    Webhook POST /webhook    REST API /api/v1/
                     (new txn)  /                 \  (categories, transactions)
                               v                   v
                    +---------------------------+
                    |        App.js (Express)     |
                    |   HTTP + Socket.IO server   |
                    |   Auth middleware (/api/*)   |
                    +------+----------+----------+
                           |          |          |
               Webhook     |   Batch  |   SSE    |
               Queue       |   API    |   Stream |
               (concurrency=1)        |          |
                           v          v          v
                    +---------------------------+
                    |  ClassificationEngine.js   |
                    |  3-stage pipeline:          |
                    |  [1] KeywordRules.js        |
                    |  [2] MerchantMemory.js      |
                    |  [3] AI Provider            |
                    +------+----------+----------+
                           |          |
                   +-------+          +-------+
                   v                          v
            +-------------+          +-----------------+
            | AiProvider   |          | BatchAnalyzer   |
            | (abstract)   |          | Seed+Parallel   |
            +------+------+          | Category Dedup  |
                   |                  +-----------------+
            +------+------+
            |             |
   +--------+---+  +-----+--------+
   | OpenAI     |  | Gemini       |
   | Provider   |  | Provider     |
   +------------+  +--------------+

    Storage Layer
    +---------------------------+
    | Database.js (SQLite/WAL)  |
    |  merchants table          |
    |  jobs table               |
    +---------------------------+
    | SecretStore.js (AES-256)  |
    | ConfigStore.js (JSON)     |
    +---------------------------+

    Frontend (public/index.html)
    +---------------------------+
    | Single-file SPA           |
    | Tabs: Setup|Classify|     |
    |       Rules|Memory|       |
    |       Settings            |
    | Socket.IO for live jobs   |
    | SSE for batch progress    |
    +---------------------------+
```

---

## Prioritized Findings Table

| # | Severity | Category | Finding | Files |
|---|----------|----------|---------|-------|
| 1 | **CRITICAL** | Missing Feature | No crypto/blockchain static categorization -- TRC20 transactions waste AI API calls | `ClassificationEngine.js` |
| 2 | **HIGH** | Duplication | Category name matching logic duplicated in 4 files (6 instances) | `ClassificationEngine.js:73-79`, `OpenAiProvider.js:33-35`, `GeminiProvider.js:30-32`, `AiProvider.js:118-120` |
| 3 | **HIGH** | Security | Webhook endpoint `/webhook` has zero authentication -- no signature, no token, no IP whitelist | `App.js:132` |
| 4 | **HIGH** | Security | No CORS, helmet, or rate limiting middleware | `App.js:82-88` |
| 5 | **HIGH** | Testing | Zero test coverage -- `test` script is `echo "Error: no test specified" && exit 1` | `package.json:9` |
| 6 | **HIGH** | Performance | JobList broadcasts full 50-job list on every event (5 call sites) | `JobList.js:68,75,94,101,107` |
| 7 | **MEDIUM** | Architecture | Provider instances are created per-call, not reused -- no connection pooling | `ClassificationEngine.js:58,133` |
| 8 | **MEDIUM** | Architecture | App.js is a God Object (539 lines, 25+ methods) mixing routing, auth, business logic | `App.js` |
| 9 | **MEDIUM** | Resilience | No graceful shutdown -- SIGTERM kills in-flight jobs and leaves DB in unknown state | `index.js` |
| 10 | **MEDIUM** | Data Flow | Webhook only processes `transactions[0]` -- split transactions ignored | `App.js:455` |
| 11 | **MEDIUM** | Frontend | Single-file 1,088-line HTML -- no build step, no component extraction, inline JS | `public/index.html` |
| 12 | **MEDIUM** | Security | Master key auto-generated to filesystem with no rotation mechanism | `SecretStore.js:96-109` |
| 13 | **MEDIUM** | Pipeline | Confidence is hardcoded to 0.85 for all AI results regardless of actual model confidence | `ClassificationEngine.js:82,142` |
| 14 | **LOW** | Duplication | `normalizeMerchantName` import used in 2 files but function only defined once (good) | `util.js`, `MerchantMemory.js`, `BatchAnalyzer.js` |
| 15 | **LOW** | Operations | Dockerfile installs `build-base python3` for native modules but leaves them in final image | `Dockerfile:2` |
| 16 | **LOW** | Config | Webhook enable/disable requires restart -- not hot-reloadable | `App.js:131-136` |
| 17 | **LOW** | Frontend | No loading skeleton, no optimistic updates, no error boundary | `public/index.html` |

---

## Detailed Findings

### F1 [CRITICAL]: No Crypto/Blockchain Static Categorization

**Problem**: When the TRC20 data-importer sends blockchain transactions to Firefly III, the categorizer receives them via webhook or batch. These transactions have:

- `destination_name` = a TRON Base58Check address (e.g., `TJYMzh5GUaeqGWDxTV3E7MaTvjXYVSgsR5`) -- 34 characters starting with `T`, Base58 alphabet
- `description` = `"USDT transfer <sha256_txid>"` or `"TRC20 outgoing transfer <sha256_txid>"`

This data is **meaningless to AI** -- there are no merchant names, no human-readable descriptions. Sending these to OpenAI/Gemini:
1. Wastes API calls (at ~$0.001-0.01 per call)
2. Always returns `null` or a random wrong category
3. Creates noise in merchant memory (learning wallet addresses as "merchants")
4. Delays processing of real transactions in the webhook queue

**Affected code**: `ClassificationEngine.js` -- the pipeline has no detection for blockchain transaction patterns. They fall through keyword rules and merchant memory, then hit the AI stage.

**Evidence from TRC20 provider** (`data-importer/app/Services/TRC20/`):
- `GetTransactionsRequest.php:256`: `$description = sprintf('%s transfer %s', $tokenSymbol, $txId)`
- `GetTransactionsRequest.php:267`: `'merchant' => $counterparty` (which is a wallet address)
- `TransactionProcessor.php:384`: `$description = sprintf('TRC20 %s transfer %s', $isOutgoing ? 'outgoing' : 'incoming', $txId)`
- `TRC20AddressValidator.php:12`: `TRC20_T_ADDRESS = '/^T[1-9A-HJ-NP-Za-km-z]{33}$/'`

**See Section: Crypto Static Categorizer Design Specification** below for the full solution.

---

### F2 [HIGH]: Duplicated Category Matching Logic

**Problem**: The exact same "try exact match, then case-insensitive fallback" pattern is copy-pasted across 4 files:

1. **`ClassificationEngine.js:73-79`** (single classify):
   ```js
   let matchedCategory = result.category && categoryNames.includes(result.category) ? result.category : null;
   if (!matchedCategory && result.category) {
       const lower = result.category.toLowerCase();
       matchedCategory = categoryNames.find(c => c.toLowerCase() === lower) || null;
   }
   ```

2. **`OpenAiProvider.js:33-35`** (single classify validation callback):
   ```js
   const matched = categories.includes(guess)
       ? guess
       : categories.find(c => c.toLowerCase() === guess.toLowerCase()) || null;
   ```

3. **`GeminiProvider.js:30-32`** (identical to #2)

4. **`AiProvider.js:118-120`** (`_parseBatchResponse` for batch classify):
   ```js
   const matched = categories.includes(guess)
       ? guess
       : categories.find(c => c.toLowerCase() === guess.toLowerCase()) || null;
   ```

This means category matching happens **twice** for single-classify: once in the provider (returning `matched`), then again in `ClassificationEngine.js` (re-matching the already-matched result). For batch, it happens once in `AiProvider._parseBatchResponse` but is not re-verified in `ClassificationEngine.classifyBatch`.

**Risk**: If matching logic is updated in one place but not others, categories will silently fail to match. The double-matching in single-classify is also wasteful.

**Fix**: Extract to a shared `matchCategory(guess, categoryList)` function in `util.js`. Have providers return the raw AI guess; let `ClassificationEngine` do all matching.

---

### F3 [HIGH]: Unauthenticated Webhook Endpoint

**Problem**: The `/webhook` endpoint (`App.js:132`) is registered outside the `/api` auth middleware scope and has zero authentication:
- No shared secret / HMAC signature verification
- No bearer token requirement
- No IP whitelist
- No Firefly III webhook secret validation

Any network-reachable client can POST crafted payloads to `/webhook`, causing:
1. Arbitrary job creation and queue processing
2. AI API cost inflation (attacker can force classification calls)
3. Merchant memory pollution (learning attacker-supplied merchant names)
4. Potential category manipulation in Firefly III

**Mitigation**: Firefly III supports webhook secrets. The categorizer should verify the `X-Signature` header or at minimum require a shared secret in the webhook URL query parameter.

---

### F4 [HIGH]: No Security Middleware

**Problem**: The Express server at `App.js:82-88` has only `express.json()` middleware. Missing:
- **helmet**: No security headers (CSP, X-Frame-Options, HSTS, etc.)
- **CORS**: No CORS configuration -- the API accepts requests from any origin
- **Rate limiting**: No rate limiting on any endpoint -- the webhook and batch endpoints are especially vulnerable
- **Body size limits**: `express.json()` uses default 100KB limit, which is adequate but not explicitly set

For a self-hosted service running in Docker, the attack surface is smaller than a public API, but these are still basic hygiene items.

---

### F5 [HIGH]: Zero Test Coverage

**Problem**: `package.json:9` has `"test": "echo \"Error: no test specified\" && exit 1"`. There are:
- No unit tests
- No integration tests
- No test framework installed (no jest, vitest, mocha in dependencies)
- No test directory

The classification pipeline, provider abstraction, batch analyzer, and config store all have significant logic that should be tested. The category matching duplication (F2) is exactly the kind of bug that tests would catch.

---

### F6 [HIGH]: Excessive Job List Broadcasting

**Problem**: `JobList.js` emits the full job list (default LIMIT 50) on every state change:
- Line 68: `createJob` -- emits `{ job, jobs: this.getJobs() }`
- Line 75: `setJobInProgress` -- emits `{ job, jobs: this.getJobs() }`
- Line 94: `updateJobResult` -- emits `{ job, jobs: this.getJobs() }`
- Line 101: `setJobError` -- emits `{ job, jobs: this.getJobs() }`
- Line 107: `correctJob` -- emits `{ job, jobs: this.getJobs() }`

Each `this.getJobs()` runs `SELECT * FROM jobs ORDER BY created DESC LIMIT 50`. During a batch apply of 500 transactions, this produces 1,500+ SELECT queries (create + in_progress + result for each) and broadcasts 1,500+ Socket.IO messages, each containing 50 full job objects.

**Fix**: Emit only the changed job (`{ job }`) and let the frontend upsert it into its local list. Add a separate `job-list-changed` event for pagination resets.

---

### F7 [MEDIUM]: Provider Instances Created Per-Call

**Problem**: `ClassificationEngine.js:58` and `ClassificationEngine.js:133` call `createProvider(providerName, apiKey, model)` on every `classify()` and `classifyBatch()` invocation. Each call creates a new `OpenAI` or `GoogleGenerativeAI` client instance.

For OpenAI, this means a new HTTP client per call. For Gemini, `getGenerativeModel()` is also called per-request inside the already-new provider.

**Fix**: Cache provider instances by `(providerName, apiKey, model)` key in `ClassificationEngine` or `ProviderRegistry`. Invalidate on settings change.

---

### F8 [MEDIUM]: App.js God Object

**Problem**: `App.js` is 539 lines with 25+ methods. It handles:
- HTTP server setup and lifecycle
- Express route registration (15 routes)
- Socket.IO setup and auth
- Webhook processing logic
- Settings CRUD
- Rules CRUD
- Memory CRUD
- Jobs CRUD
- Batch orchestration (SSE streaming)
- API auth middleware
- Error handling

This violates Single Responsibility Principle. Route handlers are small individually but the file is the hub for everything.

**Fix**: Extract route groups into separate router modules:
- `routes/settings.js`
- `routes/rules.js`
- `routes/memory.js`
- `routes/jobs.js`
- `routes/batch.js`
- `routes/webhook.js`

---

### F9 [MEDIUM]: No Graceful Shutdown

**Problem**: `index.js` has a `.catch()` handler for startup failure but no SIGTERM/SIGINT handler. On container stop:
- In-flight queue jobs are killed mid-execution
- SQLite WAL may not be checkpointed
- Socket.IO connections are dropped without close frames
- SSE streams are terminated without `error` events

**Fix**: Add signal handlers that: drain the queue, close the HTTP server, checkpoint SQLite, emit disconnect to Socket.IO clients.

---

### F10 [MEDIUM]: Webhook Ignores Split Transactions

**Problem**: `App.js:455` processes only `req.body.content.transactions[0]`. Firefly III supports split transactions where a single transaction group contains multiple splits. All splits after the first are silently ignored.

**Fix**: Iterate over all transactions in the array, or at minimum log a warning when `transactions.length > 1`.

---

### F11 [MEDIUM]: Single-File Frontend

**Problem**: `public/index.html` is 1,088 lines containing CSS, HTML, and JavaScript in a single file. The JavaScript uses a global `STATE` object and imperative DOM manipulation with `querySelector`/`innerHTML`.

This is acceptable for the current complexity but will not scale. Specific concerns:
- `innerHTML` assignments with user data use `esc()` for XSS prevention, which is good
- No component model -- adding new tabs or features requires modifying the monolith
- No build step means no minification, no tree-shaking, no TypeScript
- SSE streaming logic (`streamSSE`) is complex and error-prone to modify

---

### F12 [MEDIUM]: Master Key Lifecycle

**Problem**: `SecretStore.js:96-109` auto-generates a master key and persists it to `./storage/.master_key`. There is:
- No key rotation mechanism
- No backup/recovery procedure documented
- If the key file is lost, all encrypted secrets become unrecoverable
- The key is stored adjacent to the encrypted data (same volume mount)

**Fix**: Document key backup, add a rotation CLI command, consider using Docker secrets as the primary mechanism.

---

### F13 [MEDIUM]: Hardcoded AI Confidence

**Problem**: `ClassificationEngine.js:82` and `ClassificationEngine.js:142` both set `confidence = matchedCategory ? 0.85 : 0`. This is a static value regardless of:
- How confident the AI model actually is
- Whether the model returned a high-probability match or a wild guess
- Which model was used (GPT-4 vs GPT-3.5 vs Gemini Flash)

The AI providers strip the model's internal confidence and replace it with a blanket 0.85. This makes the confidence threshold setting (`confidenceThreshold`) a binary toggle rather than a graduated filter.

**Fix**: Have providers return the model's actual confidence (if available from the API) or derive it from log probabilities. Fall back to the static 0.85 only when the API provides no confidence signal.

---

### F15 [LOW]: Multi-Stage Docker Build Missing

**Problem**: `Dockerfile:2` installs `build-base python3` for compiling `better-sqlite3` native module, but these remain in the final image. A multi-stage build would reduce image size by ~200MB.

---

## Crypto Static Categorizer Design Specification

### Requirement

Cryptocurrency transactions from the TRC20 importer have no meaningful merchant names or descriptions. They must be statically categorized before reaching the AI stage to:
1. Avoid wasting AI API calls
2. Prevent merchant memory pollution with wallet addresses
3. Enable per-token category assignment (e.g., "Crypto", "Crypto/USDT", "Crypto/TRX")
4. Auto-create the target category in Firefly III if it does not exist

### Transaction Patterns to Detect

Based on analysis of the TRC20 provider code:

| Field | Pattern | Example |
|-------|---------|---------|
| `destination_name` | TRON Base58Check address: `/^T[1-9A-HJ-NP-Za-km-z]{33}$/` | `TJYMzh5GUaeqGWDxTV3E7MaTvjXYVSgsR5` |
| `destination_name` | Ethereum-style hex address: `/^0x[0-9a-fA-F]{40}$/` | `0x1234...abcd` |
| `description` | Token transfer pattern: `/^(USDT|TRX|USDC|ETH|BTC)\s+transfer\s+[0-9a-f]{64}$/i` | `USDT transfer a1b2c3...` |
| `description` | TRC20 transfer pattern: `/^TRC20\s+(outgoing|incoming)\s+transfer\s+/i` | `TRC20 outgoing transfer abc123...` |

### Proposed Pipeline Stage

Insert **Stage 1.5: Crypto Static Categorizer** between keyword rules and merchant memory:

```
Stage 1: KeywordRules.match()
Stage 1.5: CryptoDetector.detect()     <-- NEW
Stage 2: MerchantMemory.lookup()
Stage 3: AI Provider.classify()
```

### New File: `src/CryptoDetector.js`

```javascript
// Regex patterns for blockchain address detection
const TRON_BASE58_ADDRESS = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const ETH_HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CRYPTO_DESCRIPTION = /^(USDT|TRX|USDC|USDD|ETH|BTC|BNB|SOL|MATIC|DAI)\s+transfer\s+/i;
const TRC20_DESCRIPTION = /^TRC20\s+(outgoing|incoming)\s+transfer\s+/i;

// Extract token symbol from description
const TOKEN_SYMBOL_REGEX = /^(USDT|TRX|USDC|USDD|ETH|BTC|BNB|SOL|MATIC|DAI)\b/i;

export default class CryptoDetector {
    #defaultCategory;
    #perTokenCategories;

    constructor(configStore) {
        // configStore provides "Crypto" as default,
        // with optional per-token overrides like { USDT: "Crypto/USDT" }
        this.#defaultCategory = configStore.getCryptoCategory?.() || "Crypto";
        this.#perTokenCategories = configStore.getCryptoTokenCategories?.() || {};
    }

    detect(destinationName, description) {
        const isBlockchainAddress =
            TRON_BASE58_ADDRESS.test(destinationName) ||
            ETH_HEX_ADDRESS.test(destinationName);

        const isCryptoDescription =
            CRYPTO_DESCRIPTION.test(description) ||
            TRC20_DESCRIPTION.test(description);

        if (!isBlockchainAddress && !isCryptoDescription) {
            return null;  // Not a crypto transaction
        }

        // Extract token symbol
        const tokenMatch = description.match(TOKEN_SYMBOL_REGEX);
        const tokenSymbol = tokenMatch ? tokenMatch[1].toUpperCase() : null;

        // Determine category
        const category = tokenSymbol && this.#perTokenCategories[tokenSymbol]
            ? this.#perTokenCategories[tokenSymbol]
            : this.#defaultCategory;

        return {
            category,
            tokenSymbol,
            confidence: 1.0,
            source: `crypto:${tokenSymbol || "unknown"}`,
            needsReview: false,
        };
    }
}
```

### Integration into ClassificationEngine

In `ClassificationEngine.js`, add between stages 1 and 2:

```javascript
// Stage 1: Keyword rules (instant, no API call)
const ruleMatch = this.#keywordRules.match(destinationName, description);
if (ruleMatch && categories.has(ruleMatch.category)) { ... }

// Stage 1.5: Crypto static detection (instant, no API call)
const cryptoMatch = this.#cryptoDetector.detect(destinationName, description);
if (cryptoMatch) {
    const catId = categories.get(cryptoMatch.category);
    if (!catId) {
        // Auto-create the category in Firefly III
        await this.#categoriesCache.ensureCategory(cryptoMatch.category);
    }
    return {
        category: cryptoMatch.category,
        categoryId: catId || (await this.#categoriesCache.getCategories()).get(cryptoMatch.category),
        confidence: 1.0,
        source: cryptoMatch.source,
        needsReview: false,
    };
}

// Stage 2: Merchant memory
const memHit = this.#merchantMemory.lookup(destinationName);
```

### Category Auto-Creation

Add to `CategoriesCache.js`:

```javascript
async ensureCategory(name) {
    const categories = await this.getCategories();
    if (categories.has(name)) return categories.get(name);

    const result = await this.#fireflyService.createCategory(name);
    this.invalidate();
    return result?.data?.id || null;
}
```

### Configuration

Add to `ConfigStore.js`:

```javascript
getCryptoCategory() {
    return this.#str(this.#config.CRYPTO_CATEGORY) || process.env.CRYPTO_CATEGORY || "Crypto";
}

getCryptoTokenCategories() {
    // Format: "USDT:Crypto/USDT,TRX:Crypto/TRX"
    const raw = this.#str(this.#config.CRYPTO_TOKEN_CATEGORIES) || process.env.CRYPTO_TOKEN_CATEGORIES || "";
    if (!raw) return {};
    const result = {};
    for (const pair of raw.split(",")) {
        const [symbol, category] = pair.split(":").map(s => s.trim());
        if (symbol && category) result[symbol.toUpperCase()] = category;
    }
    return result;
}
```

### UI Addition

Add a "Crypto" section to the Settings tab with:
- Default crypto category name (text input, default "Crypto")
- Per-token category overrides (structured input with "Add Token" button, each row: symbol input + category input)
- Toggle: "Auto-create categories" (checkbox, default true)

### Batch Analyzer Integration

In `BatchAnalyzer.analyze()`, crypto detection should be applied during the `processChunkResults` phase or preferably inside `ClassificationEngine.classifyBatch()` which already runs keyword rules and merchant memory. The existing pipeline architecture handles this naturally -- just add the crypto stage to `classifyBatch()` the same way as `classify()`.

---

## Additional Architecture Observations

### Things Done Well

1. **3-stage pipeline** is a clean, extensible design. Adding crypto detection as stage 1.5 is natural.
2. **SQLite with WAL mode** is the right choice for this workload -- fast writes, no server overhead.
3. **AES-256-GCM encryption** for secrets with a proper key hierarchy (Docker secret > env var > auto-generated file).
4. **Two-pass batch workflow** (analyze, then apply) gives users control before modifying Firefly data.
5. **Seed batches followed by parallel batches** in `BatchAnalyzer` is a smart pattern for building category vocabulary.
6. **Category deduplication** post-analysis (`findCategoryDuplicates`) catches AI inconsistency.
7. **Migration system** in `Database.js` using `user_version` pragma is simple and effective.
8. **Timing-safe comparison** for API token auth (`crypto.timingSafeEqual`).
9. **ConfigStore plaintext-to-encrypted migration** is a thoughtful upgrade path.

### Design Decisions Worth Documenting (ADR Candidates)

1. **SQLite over PostgreSQL**: Right choice for single-node self-hosted. Would need migration at ~100K merchants.
2. **Socket.IO for real-time**: Used only for job list updates. SSE (already used for batch) could replace it, eliminating the dependency.
3. **Single-file frontend**: Acceptable for current scope. Should be reconsidered if adding crypto settings UI.
4. **Queue concurrency=1 for webhooks**: Prevents race conditions on category cache. Could be increased with proper locking.

---

## Recommended Implementation Plan

### Phase 1: Critical & Quick Wins (1-2 days)

| Order | Task | Severity | Effort |
|-------|------|----------|--------|
| 1.1 | Create `CryptoDetector.js` with TRON/ETH address and description pattern matching | CRITICAL | 2h |
| 1.2 | Integrate crypto detection into `ClassificationEngine.classify()` and `classifyBatch()` | CRITICAL | 1h |
| 1.3 | Add `ensureCategory()` to `CategoriesCache.js` for auto-creation | CRITICAL | 30m |
| 1.4 | Add crypto config to `ConfigStore.js` | CRITICAL | 30m |
| 1.5 | Extract shared `matchCategory(guess, categoryList)` to `util.js`, replace 4 duplicated implementations | HIGH | 1h |

### Phase 2: Security Hardening (1 day)

| Order | Task | Severity | Effort |
|-------|------|----------|--------|
| 2.1 | Add webhook secret/signature verification | HIGH | 2h |
| 2.2 | Install and configure `helmet` middleware | HIGH | 30m |
| 2.3 | Add rate limiting on `/webhook` and `/api/batch/*` | HIGH | 1h |
| 2.4 | Add `express.json({ limit: '1mb' })` explicit body limit | LOW | 5m |

### Phase 3: Performance & Resilience (1 day)

| Order | Task | Severity | Effort |
|-------|------|----------|--------|
| 3.1 | Fix JobList to emit only changed job, not full list | HIGH | 1h |
| 3.2 | Cache provider instances in ClassificationEngine | MEDIUM | 1h |
| 3.3 | Add SIGTERM/SIGINT graceful shutdown handler | MEDIUM | 1h |
| 3.4 | Multi-stage Dockerfile to reduce image size | LOW | 30m |

### Phase 4: Testing Foundation (2 days)

| Order | Task | Severity | Effort |
|-------|------|----------|--------|
| 4.1 | Install vitest, create test directory structure | HIGH | 30m |
| 4.2 | Unit tests for `CryptoDetector` (pattern matching) | HIGH | 1h |
| 4.3 | Unit tests for `KeywordRules` | HIGH | 30m |
| 4.4 | Unit tests for `matchCategory` utility | HIGH | 30m |
| 4.5 | Unit tests for `MerchantMemory` (SQLite mocked) | MEDIUM | 1h |
| 4.6 | Integration tests for `ClassificationEngine` pipeline | MEDIUM | 2h |

### Phase 5: Architecture Cleanup (2-3 days)

| Order | Task | Severity | Effort |
|-------|------|----------|--------|
| 5.1 | Extract App.js route groups into separate router modules | MEDIUM | 3h |
| 5.2 | Add crypto settings section to UI | MEDIUM | 2h |
| 5.3 | Handle split transactions in webhook | MEDIUM | 1h |
| 5.4 | Consider replacing Socket.IO with SSE for job updates | LOW | 3h |
| 5.5 | Consider extracting frontend into a build-step SPA (Vite + Alpine.js) | LOW | 1-2 days |

---

## Appendix: File-by-File Summary

| File | Lines | Purpose | Issues |
|------|-------|---------|--------|
| `index.js` | 9 | Entry point | No graceful shutdown (F9) |
| `src/App.js` | 539 | Express server, all routes, webhook, auth | God object (F8), webhook unauth (F3), no security middleware (F4) |
| `src/ClassificationEngine.js` | 175 | 3-stage classification pipeline | No crypto detection (F1), duplicated matching (F2), hardcoded confidence (F13), per-call provider creation (F7) |
| `src/BatchAnalyzer.js` | 229 | Two-pass batch analyze+apply with SSE | Clean design, no major issues |
| `src/KeywordRules.js` | 25 | Simple keyword-to-category matching | Clean, well-scoped |
| `src/MerchantMemory.js` | 96 | SQLite-backed merchant->category cache | Clean, prepared statements |
| `src/CategoriesCache.js` | 30 | TTL cache for Firefly categories | Missing `ensureCategory` for auto-creation |
| `src/ConfigStore.js` | 217 | Layered config (env + file + encrypted) | Missing crypto config, otherwise solid |
| `src/SecretStore.js` | 111 | AES-256-GCM encrypted key-value store | No key rotation (F12) |
| `src/JobList.js` | 110 | SQLite job tracking + EventEmitter | Excessive broadcasting (F6) |
| `src/db/Database.js` | 75 | SQLite connection + migrations | Clean, good WAL+FK setup |
| `src/util.js` | 68 | Shared utilities | Missing `matchCategory` function |
| `src/providers/AiProvider.js` | 124 | Abstract base class with retry/JSON parsing | Duplicated matching logic (F2) |
| `src/providers/OpenAiProvider.js` | 70 | OpenAI GPT integration | Duplicated matching logic (F2) |
| `src/providers/GeminiProvider.js` | 64 | Google Gemini integration | Duplicated matching logic (F2), model created per-request |
| `src/providers/ProviderRegistry.js` | 37 | Provider factory + model definitions | Clean, extensible |
| `public/index.html` | 1088 | Single-file SPA (CSS+HTML+JS) | Monolith (F11), otherwise functional |

---

**End of Architecture Review**

---