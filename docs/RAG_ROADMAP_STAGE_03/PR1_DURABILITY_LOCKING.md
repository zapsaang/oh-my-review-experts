# PR1: 耐久性加锁 (Durability Locking)

> **Goal**: 引入仓库级写锁守护 memory 子系统的 read-modify-write 临界区，加 fsync 确保 commit point 落盘，读路径用 hash 自检替代加锁。
>
> **Scope**: 1 新模块 `src/memory/lock.ts` + 修改 4 个写入口 + 增强 `readMaterializedState` + 修改 `writeFileAtomicOverwrite` 加 fsync + 2 新测试文件。零新 npm 依赖。
>
> **Estimated Effort**: High (4–6 hours). 4 waves, 1 PR.
>
> **Pre-requisite**: 无。本 PR 独立于 STAGE_03 其他所有 PR。

---

## 0. 关键代码定位（实现参照）

| 符号 | 位置 | 备注 |
|---|---|---|
| `MemoryPaths.lockFile` | `src/memory/paths.ts:21` | 已预留 `locks/memory.lock`，注释 "Reserved for Claim 2" |
| `MemoryPaths.locksDir` | `src/memory/paths.ts:19` | 已预留 |
| `ensureMemoryDirs` | `src/memory/paths.ts:46` | 已创建 `locksDir`（line 54） |
| `writeFileAtomicOverwrite` | `src/tools/fs-utils.ts:40` | `temp(wx)+rename`，无 fsync |
| `makeTempPath` | `src/tools/fs-utils.ts:51` | `${path}.tmp.${pid}.${now}.${random}` |
| `writeMaterializedState` | `src/memory/store.ts:69` | 写三件套：memory.jsonl → related-index.json → manifest.json(commit point) |
| `readMaterializedState` | `src/memory/store.ts:27` | 读三件套，当前无完整性校验 |
| `hashFindings` | `src/memory/store.ts:248` | `sha256(ids.join("\n")).slice(0,16)` — 已存在，manifest.materializedHash 用此 |
| `runIndexLatest` 临界区 | `src/memory/indexing.ts:144-150` | `writeEventSegment → readAllEventSegments → rebuild → writeMaterializedState` |
| `runMemoryMark` 临界区 | `src/memory/mark.ts:81-85` | `writeEventSegment → readAllEventSegments → rebuild → writeMaterializedState` |
| `runMemoryGc` 临界区 | `src/memory/gc.ts:59+168-205` | `readMaterializedState → deletions → writeMaterializedState` |
| `runMemoryCompact` 临界区 | `src/memory/compact.ts:34-79` | `listUncompacted → merge → writeCompactedFile → updateManifest(readState+writeState)` |
| `updateManifest` | `src/memory/compact.ts:184` | 内部 `readMaterializedState → writeMaterializedState` |
| `writeEventSegment` | `src/memory/events.ts:54` | `wx` + 唯一文件名 — **不需要锁** |
| `assertSafePath` | `src/tools/fs-utils.ts:5` | 路径穿越防护 |

---

## 1. 问题陈述

`writeMaterializedState`（store.ts:69）通过 `writeFileAtomicOverwrite`（temp+rename）逐个写三件套。**单文件原子但跨文件无原子性**：

1. **撕裂读**：进程 B 在进程 A 写完 `memory.jsonl` 但未写完 `manifest.json` 时读取，得到不一致状态。
2. **无 fsync**：崩溃后 rename 可能未持久化到磁盘（ext4 默认 `data=ordered` 只保证数据先于元数据，不保证目录项 rename 持久）。
3. **无互斥**：两个写进程的 read-modify-write 周期交错，后写者覆盖先写者，丢失事件。

---

## 2. 设计决策

### 2.1 锁路径

使用已预留的 `paths.lockFile`（`src/memory/paths.ts:21`）= `.omre/memory/locks/memory.lock`。

锁的物理形态：**创建 `memory.lock` 为目录**（`fs.mkdirSync`）。成功创建 = 获锁。内部写 `owner.json` 携带元数据。`owner.json` 主要供陈旧检测；其缺失时退回 lockDir mtime 兜底（§4.2 `isStaleByMtime`），非正确性依赖。

```
.omre/memory/locks/memory.lock/        ← fs.mkdirSync 原子创建
  └─ owner.json                        ← { pid, hostname, acquiredAt }
```

> 命名说明：`paths.lockFile` 名为 file 但实际以**目录**形态使用（`fs.mkdirSync`）。保留该命名以不改动 paths.ts 公开 API；此为有意决策，非债务。

### 2.2 锁的生命周期

| 阶段 | 操作 | 原子性保证 |
|---|---|---|
| **获取** | `fs.mkdirSync(lockDir)` | POSIX mkdir 原子 — EEXIST = 已被持有；父目录 locks/ 由 acquireMemoryLock 内部 recursive 预建 |
| **写 owner** | `fs.writeFileSync(owner.json, ...)` | 非原子；缺失时（持有者崩溃于 mkdir 与写 owner 之间）由 lockDir mtime 兜底陈旧检测（FIX-2），不再仅依赖 timeoutMs |
| **等待** | 轮询 `owner.json` 的 `acquiredAt`，小于 staleMs 则继续等 | — |
| **陈旧回收** | `fs.renameSync(lockDir, lockDir + ".stale." + pid)` | rename 原子 — 只有一个进程能 rename 成功 |
| **清理被夺** | `fs.rmSync(renamedDir, { recursive: true })` | 已获锁的进程清理 |
| **重试** | 回到 mkdir | — |
| **释放** | `fs.rmSync(lockDir, { recursive: true })` | 已在临界区外 |

### 2.3 参数

```typescript
export interface AcquireLockOptions {
  timeoutMs?: number;   // 默认 10_000 — 抢不到锁的最大等待
  staleMs?: number;     // 默认 60_000 — 超此龄视为崩溃遗留
  pollMs?: number;      // 默认 50 — 轮询间隔
}
```

**理由**：
- `timeoutMs=10s`：写操作通常 <1s 完成；10s 足以覆盖极端大仓库场景，超出则报错。
- `staleMs=60s`：正常写操作远快于此；60s 偏保守，避免误夺正在 GC 大段的合法锁。
- `pollMs=50ms`：足够快响应且不烧 CPU。

### 2.4 fsync 策略

**仅在临界区出口 fsync 一次**（manifest 文件 + 其所在目录）。

修改 `writeFileAtomicOverwrite` 新增可选参数 `fsync?: boolean`。`writeMaterializedState` 写 manifest.json 时传 `fsync: true`。

```typescript
// writeFileAtomicOverwrite 修改后
export function writeFileAtomicOverwrite(
  filePath: string,
  content: string,
  options?: { fsync?: boolean },
): void {
  const tmpFile = makeTempPath(filePath);
  try {
    fs.writeFileSync(tmpFile, content, { flag: "wx", encoding: "utf8" });
    if (options?.fsync) {
      const fd = fs.openSync(tmpFile, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, filePath);
    if (options?.fsync) {
      // 文件 content fsync（上方已完成）保证数据落盘。
      // 目录 fsync 保证 rename 持久化（POSIX 必需）。
      // Windows NTFS 不支持目录 fsync（openSync 抛 EPERM/EACCES）→ best-effort 忽略。
      // FlushFileBuffers 在 rename 后由 OS 保证 metadata flush（NTFS journaling）。
      try {
        const dirPath = path.dirname(filePath);
        const dirFd = fs.openSync(dirPath, "r");
        fs.fsyncSync(dirFd);
        fs.closeSync(dirFd);
      } catch {
        // best-effort: 平台不支持目录 fsync 时静默（NTFS journal 已覆盖）
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { }
    throw err;
  }
}
```

**只有 manifest.json 触发 fsync**（`writeMaterializedState` 的最后一步）。memory.jsonl 和 related-index.json 不 fsync — 它们在 manifest 之前写入；如果崩溃发生在它们写完但 manifest 未更新之前，manifest 还保留旧 hash → 下次启动时重建会发现不一致并重做。这是安全的。

### 2.5 读路径自检

`readMaterializedState`（store.ts:27）增强：读完三件套后校验 `hashFindings(findings) === manifest.materializedHash`。

```typescript
// store.ts readMaterializedState 内部（return 之前）
const computed = hashFindings(findings);
if (computed !== manifest.materializedHash) {
  // 可能读到写一半的状态；重试一次
  return readMaterializedStateRetry(paths, /* maxRetries */ 1);
}
```

**重试上限 = 1 次**。如果重试后仍不一致，说明真正的数据损坏（非并发撕裂），按现有 null 返回路径处理（调用方会抛 "no memory state found" 或降级）。

> 自检局限交叉引用：`hashFindings` 仅 hash finding id，检不出仅状态变更的撕裂（见 §6.1 FIX-7 注，DEFERRED）。relatedIndex 撕裂读检测 DEFERRED（见 §6.1 Momus 缺口注）。

> **决策（已定）——重试逻辑的真实受益者是锁外读者**：`readMaterializedState` 在 `runMemoryMark` / `runMemoryGc` / `runMemoryCompact`（含其内部 `updateManifest`）中均为**锁内调用**——此时本进程已独占写锁，不可能读到并发写一半的撕裂态，hash 自检永远一致、重试路径**不可达**。重试逻辑真正保护的是**锁外读者**：`omre memory trends`（PR5）、`omre memory stats`、search/pipeline 路径——它们读 materialized state 时不持锁，可能撞上某个写进程正在覆盖三件套的中间态。统一在 `readMaterializedState` 内实现自检，使锁内/锁外调用走同一代码路径，简化心智模型。实施时在该函数加一行注释说明此不对称。重试前用 `sleepBeforeRetry(READ_RETRY_DELAY_MS)` 短暂退避（FIX-4），避免立即重读撞上同一写中间态。

### 2.6 `writeEventSegment` 不加锁

`writeEventSegment`（events.ts:54）使用 `wx` 标志 + `timestamp-pid-random-runId.jsonl` 唯一文件名。两个进程创建同名文件的概率为 0（pid+random+timestamp）。它是**纯追加一个新文件**，不存在 read-modify-write — 无需互斥。

---

## 3. 文件变更清单

### 3.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/memory/lock.ts` | 锁模块：`acquireMemoryLock` / `releaseMemoryLock` / `withMemoryLock` |
| `test/memory/lock.test.ts` | 锁单元测试 |
| `test/memory/lock-concurrency.test.ts` | 并发守护测试 |

### 3.2 修改文件

| 文件 | 变更 |
|---|---|
| `src/tools/fs-utils.ts` | `writeFileAtomicOverwrite` 新增 `options?: { fsync?: boolean }` 参数 |
| `src/memory/store.ts` | `writeMaterializedState` 写 manifest 时传 `{ fsync: true }` |
| `src/memory/store.ts` | `readMaterializedState` 增加 hash 自检 + 单次重试 |
| `src/memory/indexing.ts` | `runIndexLatest` 临界区包裹 `withMemoryLock` |
| `src/memory/mark.ts` | `runMemoryMark` 临界区包裹 `withMemoryLock` |
| `src/memory/gc.ts` | `runMemoryGc` 临界区包裹 `withMemoryLock` |
| `src/memory/compact.ts` | `runMemoryCompact` 临界区包裹 `withMemoryLock` |
| `src/memory/paths.ts` | 移除 `lockFile` / `locksDir` 注释中的 "Not yet implemented" |

---

## 4. 模块设计：`src/memory/lock.ts`

### 4.1 完整公开 API

```typescript
import fs from "node:fs";
import path from "node:path";
import { assertSafePath } from "../tools/fs-utils.js";
import type { MemoryPaths } from "./paths.js";

export interface LockHandle {
  lockDir: string;
  acquiredAt: string;
}

export interface AcquireLockOptions {
  timeoutMs?: number;   // default 10_000
  staleMs?: number;     // default 60_000
  pollMs?: number;      // default 50
}

export interface LockOwnerInfo {
  pid: number;
  hostname: string;
  acquiredAt: string;
}

/**
 * 获取仓库级内存写锁。阻塞至获取或超时。
 * 抛出：timeoutMs 到期仍未获取。
 */
export function acquireMemoryLock(
  paths: MemoryPaths,
  opts?: AcquireLockOptions,
): LockHandle;

/**
 * 释放锁。幂等——锁目录不存在时不报错。
 */
export function releaseMemoryLock(handle: LockHandle): void;

/**
 * 获锁 → 执行 fn → 释锁。fn 抛异常时也保证释锁（try/finally）。
 */
export function withMemoryLock<T>(
  paths: MemoryPaths,
  fn: () => T,
  opts?: AcquireLockOptions,
): T;
```

### 4.2 内部实现伪代码（钉死算法，非示意）

```typescript
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 50;

export function acquireMemoryLock(
  paths: MemoryPaths,
  opts?: AcquireLockOptions,
): LockHandle {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;

  const lockDir = paths.lockFile; // .omre/memory/locks/memory.lock
  assertSafePath(lockDir, paths.root, "memory.lock");

  // FIX-1: 锁模块自给自足——gc.ts / compact.ts 不调用 ensureMemoryDirs，
  // 若父目录 locks/ 不存在，下面非 recursive 的 fs.mkdirSync(lockDir) 会抛 ENOENT。
  // 用 recursive 先建父目录（幂等），不依赖调用方先建。
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });

  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir); // 原子获取（非 recursive — 已存在则 EEXIST）
      break;
    } catch (err: unknown) {
      if (!isEexist(err)) throw err;

      // lockDir 已存在 — 检查是否陈旧
      // FIX-2: owner.json 可能缺失（持有者在 mkdir 与 writeFileSync(owner.json) 之间崩溃）。
      // 此时退回用 lockDir 的 mtime 判定陈旧，否则陈旧检测永不触发、只能等 timeoutMs。
      const owner = readOwnerSafe(lockDir);
      const stale =
        owner !== null
          ? isStale(owner, staleMs)
          : isStaleByMtime(lockDir, staleMs);
      if (stale) {
        // 尝试原子夺取
        const staleDest = `${lockDir}.stale.${process.pid}`;
        try {
          fs.renameSync(lockDir, staleDest);
          // rename 成功 = 我赢了，清理被夺目录
          fs.rmSync(staleDest, { recursive: true, force: true });
          continue; // 回到 mkdir
        } catch {
          // rename 失败 = 别人先夺了，回到轮询
        }
      }

      // 等待
      if (Date.now() >= deadline) {
        throw new Error(
          `memory lock timeout: could not acquire ${lockDir} within ${timeoutMs}ms` +
          (owner ? ` (held by pid=${owner.pid} since ${owner.acquiredAt})` : ""),
        );
      }
      sleepSync(jitteredPollMs(pollMs));
    }
  }

  // 获锁成功 — 写 owner metadata
  const acquiredAt = new Date().toISOString();
  const ownerInfo: LockOwnerInfo = {
    pid: process.pid,
    hostname: hostname(),
    acquiredAt,
  };
  const ownerPath = path.join(lockDir, "owner.json");
  fs.writeFileSync(ownerPath, JSON.stringify(ownerInfo), "utf8");

  return { lockDir, acquiredAt };
}

// FIX-3 已知边界：基于时间的陈旧夺取无法 100% 防止 A 被夺后又删掉 B 的锁。
// 缓解：staleMs(60s) 远大于正常写时长(<1s)，60x 安全裕度使其在实践中不可达。
// 强化方案（owner token 校验后再删）记为 DEFERRED，不在 PR1 范围。
// 注：stale steal 后旧进程（A）若恢复，仍可能完成其临界区写操作（split-brain）。
// 安全性论据：rebuild 幂等 + 全事件重算 = 最终一致，不丢数据。详见 §14。
export function releaseMemoryLock(handle: LockHandle): void {
  fs.rmSync(handle.lockDir, { recursive: true, force: true });
}

export function withMemoryLock<T>(
  paths: MemoryPaths,
  fn: () => T,
  opts?: AcquireLockOptions,
): T {
  const handle = acquireMemoryLock(paths, opts);
  try {
    return fn();
  } finally {
    releaseMemoryLock(handle);
  }
}
```

**辅助函数**：

```typescript
import { hostname } from "node:os";

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "EEXIST";
}

function readOwnerSafe(lockDir: string): LockOwnerInfo | null {
  try {
    const raw = fs.readFileSync(path.join(lockDir, "owner.json"), "utf8");
    return JSON.parse(raw) as LockOwnerInfo;
  } catch {
    return null;
  }
}

function isStale(owner: LockOwnerInfo, staleMs: number): boolean {
  const elapsed = Date.now() - new Date(owner.acquiredAt).getTime();
  return elapsed > staleMs;
}

function isStaleByMtime(lockDir: string, staleMs: number): boolean {
  try {
    const elapsed = Date.now() - fs.statSync(lockDir).mtimeMs;
    return elapsed > staleMs;
  } catch {
    // lockDir 刚被别的进程清理 — 视为不陈旧，回到轮询/重试 mkdir
    return false;
  }
}

function sleepSync(ms: number): void {
  // 真正阻塞当前线程，不烧 CPU。Atomics.wait 在一个无人 notify 的
  // SharedArrayBuffer 上等待，超时即返回——等价于同步 sleep。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function jitteredPollMs(base: number): number {
  // ±20% 随机抖动，避免 N-worker 并发测试惊群
  return Math.round(base * (0.8 + Math.random() * 0.4));
}
```

> **决策（已定）**：`sleepSync` 用 `Atomics.wait`，**不用 busy-wait**。理由：并发守护测试（`lock-concurrency.test.ts`）会人为制造高竞争——10 个 fork worker 同时抢锁，每个等待期若是 busy-loop，在单核 CI 容器上会引起 CPU 饥饿和 flaky timeout。`Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)` 真正让出 CPU，超时返回，语义与 sleep 一致，零依赖、跨平台。生产路径竞争极少，但测试路径必须稳。并发测试用 10 worker 抢锁时抖动（`jitteredPollMs`，见上方伪代码）避免惊群（thundering herd）；生产路径竞争罕见，抖动开销可忽略。

### 4.3 模块导出

`src/memory/lock.ts` 不导出到 `src/index.ts`（内部模块）。4 个写入口直接 import。

---

## 5. 四处写入口的包裹方式

### 5.1 `runIndexLatest`（indexing.ts:51）

**锁包裹范围**：从 `ensureMemoryDirs(paths)` 之后（line 142）到 `writeMaterializedState(paths, state)` 之后（line 150）。

`writeEventSegment`（line 144）在锁内——虽然它本身不需要锁保护，但它必须在 `readAllEventSegments` 之前执行，与 rebuild+write 是同一个原子事务的一部分。如果放在锁外，另一进程可能在段写入后、重建前也写入一段并重建，导致本进程重建时"偷到"别人的段但别人的重建也包含了自己的段——重复计算。

```typescript
// indexing.ts 修改示意（精确位置）
import { withMemoryLock } from "./lock.js";

// line 140 附近（assertCompatibleEventSchema 之后、ensureMemoryDirs 之后）
assertCompatibleEventSchema(paths);
ensureMemoryDirs(paths);

const result = withMemoryLock(paths, () => {
  const segment = writeEventSegment(paths, dedupeResult.events.sort(compareMemoryEvents), runId);
  const { events: allEvents, skipped } = readAllEventSegments(paths);
  if (skipped > 0) {
    output.log(`warning: skipped ${skipped} corrupted event lines during rebuild`);
  }
  const state = rebuildMaterializedStateFromEvents(allEvents);
  writeMaterializedState(paths, state);
  return { segment, state, skipped };
});

output.log(`event segment: ${result.segment.segmentPath}`);
output.log(`materialized findings: ${result.state.findings.length}`);
```

> 锁持有成本：`writeMaterializedState`（store.ts:69）内部调用 `scanEventFiles`（store.ts:76）读取磁盘上**所有**事件文件并计算 SHA-256，故锁持有时长为 O(磁盘事件总量)。PR1 规模下可接受；若未来事件量增大，可将 scanEventFiles 移出锁或增量化（DEFERRED）。

> 为何 `readMaterializedState`（indexing.ts:105）**故意在锁外**：它只为去重提供提示；真正的重建在锁内重新读取**全部**事件段（readAllEventSegments→rebuild），故锁外读到的陈旧去重信息至多导致**冗余事件**（被 rebuild 的 findingIds Set 去重），绝不损坏状态。

### 5.2 `runMemoryMark`（mark.ts:49）

**锁包裹范围**：从 `readMaterializedState` 之后的状态检查（line 53）到 `writeMaterializedState`（line 85）。

但仔细看：mark 先读状态验证 finding 存在和转换合法（line 53-68），然后写事件段+重建+写。如果不把读也包在锁内，两个并发 mark 可能都验证通过但产生冲突事件。因此**整个函数体从 `readMaterializedState` 起**都在锁内。

```typescript
// mark.ts 修改示意
import { withMemoryLock } from "./lock.js";

export function runMemoryMark(options: MarkOptions): MarkResult {
  const paths = resolveMemoryPaths(options.cwd ?? process.cwd());
  ensureMemoryDirs(paths);

  return withMemoryLock(paths, () => {
    const state = readMaterializedState(paths);
    if (state === null) {
      throw new Error("no memory state found");
    }

    const finding = state.findings.find((candidate) => candidate.id === options.findingId);
    if (finding === undefined) {
      throw new Error(`finding not found: ${options.findingId}`);
    }

    const previousStatus = finding.status;
    const newStatus = normalizeMemoryStatus(options.status);

    if (!isValidTransition(previousStatus, newStatus)) {
      throw new Error(`invalid transition: ${previousStatus} → ${newStatus}`);
    }

    const batchCtx = createEventBatchContext(MARK_RUN_ID);
    const event = MemoryEventSchema.parse({
      type: "finding.status_changed",
      eventId: nextEventId(batchCtx),
      at: new Date().toISOString(),
      findingId: options.findingId,
      from: previousStatus,
      to: newStatus,
      markedBy: MARK_MARKED_BY,
    });

    const segment = writeEventSegment(paths, [event], MARK_RUN_ID);

    const { events } = readAllEventSegments(paths);
    const rebuilt = rebuildMaterializedStateFromEvents(events);
    writeMaterializedState(paths, rebuilt);

    return {
      success: true,
      findingId: options.findingId,
      previousStatus,
      newStatus,
      eventId: event.eventId,
      segmentPath: segment.segmentPath,
    };
  });
}
```

### 5.3 `runMemoryGc`（gc.ts:50）

**锁包裹范围**：gc 的模式不同——它先读 manifest+state（line 59），然后做大量**只读**计划（line 62-165），最后执行删除 + 写 manifest（line 167-206）。

将锁包在**执行阶段**（line 167-206），不包规划阶段。理由：
- 规划阶段纯读+CPU 计算，耗时可能较长（大仓库）。
- 删除+写 manifest 才是需要互斥的部分。
- 但规划阶段用的 state 可能在规划期间被别人改了 → **整体包裹更安全**。

最终决策：**整体包裹**（从 `readMaterializedState` 到 `writeMaterializedState`），即从 line 59 到 line 206。dryRun 路径也包裹（简单统一，代价 = 极短的无竞争锁持有）。

> 注：gc/compact 不调用 `ensureMemoryDirs`；锁的父目录由 `acquireMemoryLock` 内部 recursive 创建（见 §4.2 FIX-1），故无 ENOENT 风险。

```typescript
// gc.ts 修改示意
import { withMemoryLock } from "./lock.js";

export function runMemoryGc(options: GcOptions): GcResult {
  const cwd = options.cwd ?? process.cwd();
  const dryRun = options.dryRun === true;
  const config = loadConfigUnsafe(cwd);
  const paths = resolveMemoryPaths(cwd, config.memory.directory);

  return withMemoryLock(paths, () => {
    const retention = config.memory.retention;
    const state = readMaterializedState(paths);
    const manifest = state?.manifest ?? null;
    // ... 现有规划逻辑不变 ...
    // ... 现有删除逻辑不变 ...
    // ... 现有 writeMaterializedState 不变 ...
    return { success: true, deleted, gcLogPath };
  });
}
```

### 5.4 `runMemoryCompact`（compact.ts:27）

**锁包裹范围**：从 `listUncompactedRawSegments`（line 34）到 `updateManifest`（line 79）。

关键点：`updateManifest`（compact.ts:184）内部做了 `readMaterializedState → writeMaterializedState`。它必须在锁内，否则 read-modify-write 交错。而 `writeCompactedFile`（line 66）写入一个新的 compacted 段文件——类似 `writeEventSegment`，用唯一文件名。但 `updateManifest` 依赖刚写入的段，所以两者必须在同一个锁周期。

> **决策（已定）——`updateManifest` 绝不自行获锁**：`withMemoryLock` **不可重入**。`runMemoryCompact` 在最外层获锁后，其调用链内的 `updateManifest` → `readMaterializedState` / `writeMaterializedState` **都不得调用 `withMemoryLock`**，否则同进程二次 `fs.mkdirSync(lockDir)` 抛 `EEXIST`→进入轮询→自我死锁直至 `timeoutMs` 报错。代码已验证：`updateManifest`（compact.ts:184-196）、`readMaterializedState`（store.ts:27）、`writeMaterializedState`（store.ts:69）当前均**不获锁**，锁只加在四个顶层入口。实施 PR1 时**只在四个顶层入口包裹 `withMemoryLock`，绝不下沉到 store/compact 内部函数**。`writeMaterializedState` 保持无锁这一点已列入回归验收 §11.2 #14。

dryRun 路径（line 39-41）无状态修改，但为统一和安全也包裹。

> 注：gc/compact 不调用 `ensureMemoryDirs`；锁的父目录由 `acquireMemoryLock` 内部 recursive 创建（见 §4.2 FIX-1），故无 ENOENT 风险。

```typescript
// compact.ts 修改示意
import { withMemoryLock } from "./lock.js";

export function runMemoryCompact(options: CompactOptions = {}): CompactResult {
  const start = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfigUnsafe(cwd).memory;
  const paths = resolveMemoryPaths(cwd, config.directory);

  return withMemoryLock(paths, () => {
    const maxDurationMs = config.compaction.maxCompactDurationMs;
    const uncompacted = listUncompactedRawSegments(paths);
    if (uncompacted.length === 0) {
      return { success: true, compactedSegments: [], durationMs: Date.now() - start };
    }

    if (options.dryRun) {
      const planned = planDryRun(paths, uncompacted);
      return { success: true, compactedSegments: planned, durationMs: Date.now() - start };
    }

    // ... 现有 merge + writeCompactedFile + updateManifest 不变 ...
    return { success: true, compactedSegments: [...], durationMs: Date.now() - start };
  });
}
```

---

## 6. `readMaterializedState` 增强

### 6.1 Hash 自检

```typescript
// store.ts readMaterializedState 修改（return 之前追加）
export function readMaterializedState(paths: MemoryPaths): MaterializedState | null {
  return readMaterializedStateImpl(paths, /* retryCount */ 0);
}

const MAX_READ_RETRIES = 1;
const READ_RETRY_DELAY_MS = 25;
// sleepBeforeRetry 可复用 lock.ts 的 Atomics.wait sleepSync（提取为共享小工具，
// 或在 store.ts 内联同实现）；不得 busy-wait。

function readMaterializedStateImpl(
  paths: MemoryPaths,
  retryCount: number,
): MaterializedState | null {
  const manifest = readMemoryManifest(paths);
  if (manifest === null) {
    return null;
  }

  // ... 现有 findings / relatedIndex 读取不变 ...

  const computed = hashFindings(findings);
  if (computed !== manifest.materializedHash) {
    if (retryCount < MAX_READ_RETRIES) {
      // FIX-4: 重试前短暂退避，避免立即重读撞上同一写中间态。
      // 复用 lock.ts 的 sleepSync（Atomics.wait），约一个 pollMs。
      sleepBeforeRetry(READ_RETRY_DELAY_MS);
      return readMaterializedStateImpl(paths, retryCount + 1);
    }
    // 重试后仍不一致 — 真正的数据损坏，返回 null 让调用方处理
    return null;
  }

  return { findings, manifest, relatedIndex };
}
```

> Hash 局限（FIX-7）：`hashFindings`（store.ts:248）只对 finding **id** 求 hash，不含 status/属性。故自检能检出 finding 的增删导致的撕裂，但**检不出**仅状态变更（id 集合不变）的撕裂——此时读者可能拿到旧 status。可接受：读消费者本就容忍“上一轮”快照（见 §2.5）。若需强一致，可改为对完整内容求 hash（DEFERRED）。

> relatedIndex 一致性（Momus 缺口）：当前自检只校验 `materializedHash`（findings），**不校验** `relatedIndexHash`。relatedIndex 撕裂读发生在：memory.jsonl(new) + related-index.json(old) + manifest(new, hash matches new findings)——此时 findings 通过校验但 relatedIndex 陈旧。影响有限：relatedIndex 是派生数据（used by search/trends），不影响 finding 正确性。明确 DEFERRED：若需检测可加 `hashRelatedIndex(relatedIndex) === manifest.relatedIndexHash`，复杂度等同 FIX-7 全内容 hash 方案。

### 6.2 `hashFindings` 导出

`hashFindings`（store.ts:248）当前是 `function`（无 export）。需要改为 module-level 可见（在同文件内 `readMaterializedStateImpl` 可直接调用，无需额外导出）。**不需要改动**——它在同一文件中已可见。

---

## 7. `writeFileAtomicOverwrite` 修改

### 7.1 变更

```typescript
// src/tools/fs-utils.ts:40 修改
import path from "node:path";

export function writeFileAtomicOverwrite(
  filePath: string,
  content: string,
  options?: { fsync?: boolean },
): void {
  const tmpFile = makeTempPath(filePath);
  try {
    fs.writeFileSync(tmpFile, content, { flag: "wx", encoding: "utf8" });
    if (options?.fsync) {
      const fd = fs.openSync(tmpFile, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, filePath);
    if (options?.fsync) {
      // 文件 content fsync（上方已完成）保证数据落盘。
      // 目录 fsync 保证 rename 持久化（POSIX 必需）。
      // Windows NTFS 不支持目录 fsync（openSync 抛 EPERM/EACCES）→ best-effort 忽略。
      // FlushFileBuffers 在 rename 后由 OS 保证 metadata flush（NTFS journaling）。
      try {
        const dirPath = path.dirname(filePath);
        const dirFd = fs.openSync(dirPath, "r");
        fs.fsyncSync(dirFd);
        fs.closeSync(dirFd);
      } catch {
        // best-effort: 平台不支持目录 fsync 时静默（NTFS journal 已覆盖）
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { }
    throw err;
  }
}
```

### 7.2 调用点变更

`writeMaterializedState`（store.ts:69）中写 `manifest.json` 的调用（line 91）改为：

```typescript
// 写 manifest.json LAST (commit point) — with fsync
writeFileAtomicOverwrite(paths.manifestFile, manifestContent, { fsync: true });
```

其他两处（memory.jsonl、related-index.json）**不传 fsync**——它们在 manifest 之前写入，崩溃时 manifest 未更新 = 下次重建。

---

## 8. 测试设计

### 8.1 `test/memory/lock.test.ts`（单元测试）

| # | 测试场景 | 断言 |
|---|---|---|
| 1 | `acquireMemoryLock` 成功创建 lockDir | `fs.existsSync(lockDir)` + `owner.json` 包含 pid/hostname/acquiredAt |
| 2 | `acquireMemoryLock` 在已持有锁时轮询等待并超时 | 抛错 message 含 "memory lock timeout" |
| 3 | 陈旧锁被回收：设 acquiredAt 超 staleMs | 第二次 acquire 成功 + 旧 lockDir 不存在 |
| 4 | rename 夺锁防双夺：模拟两个进程同时检测到陈旧 | 用 mock renameSync 让第二个调用抛 ENOENT → 回到轮询 |
| 5 | `releaseMemoryLock` 删除 lockDir | `!fs.existsSync(lockDir)` |
| 6 | `releaseMemoryLock` 幂等 | 已删除后再调用不抛错 |
| 7 | `withMemoryLock` fn 正常返回 | 返回 fn 值 + lockDir 已清理 |
| 8 | `withMemoryLock` fn 抛异常仍释锁 | 异常被重抛 + lockDir 不存在 |
| 9 | `assertSafePath` 被调用 | paths.lockFile 设为穿越路径 → 抛错 |
| 10 | `acquireMemoryLock` 父目录 locks/ 不存在时仍成功获锁（FIX-1） | 删除 locksDir → acquire → `fs.existsSync(lockDir)` true + 父目录被 recursive 创建 |
| 11 | `readMaterializedState` hash 不一致触发重试 | mock 第一次读到旧 findings → 退避后重试 → 一致（验证 sleepBeforeRetry 被调用一次） |
| 12 | `readMaterializedState` 重试后仍不一致返回 null | 连续不一致 → 返回 null |
| 13 | `writeFileAtomicOverwrite` fsync=true 调用 fsyncSync | spy 验证 `fs.fsyncSync` 被调用 2 次（文件+目录） |
| 14 | `writeFileAtomicOverwrite` fsync=undefined 不调用 fsyncSync | spy 验证 0 次 |
| 15 | owner.json 缺失时用 mtime 判定陈旧（FIX-2） | 建锁目录但不写 owner.json，设其 mtime 超 staleMs → 第二次 acquire 成功夺锁 |

### 8.2 `test/memory/lock-concurrency.test.ts`（并发守护）

| # | 测试场景 | 方法 | 断言 |
|---|---|---|---|
| 1 | 并发 10 次 `runMemoryMark` | `Promise.all` + `worker_threads` 或 `child_process.fork` 10 个 worker | 所有 mark 完成 + `materializedHash` 与 `hashFindings(findings)` 一致 + findings 数量正确 |
| 2 | 并发 `runIndexLatest` + `runMemoryMark` | 2 个 worker 同时执行 | state 完整无损坏，events = 两者之和 |
| 3 | 并发写下读路径稳定 | writer worker 连续写 + main 线程连续读 | 每次返回非 null（hash 自检 + 退避重试）；允许在极端竞争下偶发 null，但断言 null 比例 < 5% |
| 4 | 锁竞争不死锁 | 两个 worker 各获锁→释放→再获锁 循环 50 次 | 全部完成无超时 |

**并发测试实现方式**：使用 `child_process.fork` 启动独立进程（而非 worker_threads），因为：
- `fs.mkdirSync` 的原子性是 OS 层面的，进程间有效。
- worker_threads 共享地址空间但 fs 操作也是系统调用级原子的——两者都可以，但 fork 更真实模拟多进程场景。

Worker 脚本放在 `test/memory/_lock-worker.ts`：

```typescript
// test/memory/_lock-worker.ts
// 接收 { cwd, findingId, status } via process.argv
// 调用 runMemoryMark({ cwd, findingId, status })
// 输出 JSON 结果到 stdout
```

---

## 9. 导入依赖清单

### 9.1 `src/memory/lock.ts` 导入

| 导入 | 来源 | 用途 |
|---|---|---|
| `fs` | `node:fs` | mkdirSync / renameSync / rmSync / writeFileSync / readFileSync |
| `path` | `node:path` | path.join |
| `hostname` | `node:os` | owner metadata |
| `assertSafePath` | `../tools/fs-utils.js` | 路径穿越防护 |
| `MemoryPaths` (type) | `./paths.js` | 类型 |

### 9.2 四个写入口新增导入

| 文件 | 新增导入 |
|---|---|
| `src/memory/indexing.ts` | `import { withMemoryLock } from "./lock.js";` |
| `src/memory/mark.ts` | `import { withMemoryLock } from "./lock.js";` |
| `src/memory/gc.ts` | `import { withMemoryLock } from "./lock.js";` |
| `src/memory/compact.ts` | `import { withMemoryLock } from "./lock.js";` |

### 9.3 `src/tools/fs-utils.ts` 新增导入

| 导入 | 来源 | 用途 |
|---|---|---|
| `path` | `node:path` | `path.dirname` for directory fsync |

---

## 10. TDD 步骤（实施顺序）

### Wave 1: 锁模块骨架 + 基础测试（RED → GREEN）

1. 创建 `test/memory/lock.test.ts`，写测试 #1-#10（全部 RED）。
2. 创建 `src/memory/lock.ts`，实现 `acquireMemoryLock` / `releaseMemoryLock` / `withMemoryLock`。
3. 跑测试使 #1-#10 GREEN。
4. `npm run typecheck`。

### Wave 2: fsync + readMaterializedState 增强（RED → GREEN）

5. 在 `test/memory/lock.test.ts` 追加测试 #11-#15。
6. 修改 `src/tools/fs-utils.ts`：`writeFileAtomicOverwrite` 加 `options?.fsync`。
7. 修改 `src/memory/store.ts`：`writeMaterializedState` manifest 写入传 `{ fsync: true }`。
8. 修改 `src/memory/store.ts`：`readMaterializedState` 加 hash 自检 + 重试。
9. 跑测试使 #11-#15 GREEN。
10. `npm run typecheck` + `vitest run`（全量 1447 测试不回归）。

### Wave 3: 四处写入口包裹 + 全量回归

11. 修改 `src/memory/indexing.ts`：`withMemoryLock` 包裹。
12. 修改 `src/memory/mark.ts`：`withMemoryLock` 包裹。
13. 修改 `src/memory/gc.ts`：`withMemoryLock` 包裹。
14. 修改 `src/memory/compact.ts`：`withMemoryLock` 包裹。
15. 修改 `src/memory/paths.ts`：移除 "Not yet implemented" 注释。
16. `npm run typecheck` + `vitest run`（全量 1447 测试不回归）。

### Wave 4: 并发守护测试（RED → GREEN）

17. 创建 `test/memory/_lock-worker.ts`。
18. 创建 `test/memory/lock-concurrency.test.ts`，写测试 #1-#4（RED）。
19. 跑测试 GREEN。
20. 最终全量验证：`npm run typecheck && vitest run`。

---

## 11. 验收标准

### 11.1 功能验收

| # | 标准 | 验证方式 | 来源 |
|---|---|---|---|
| 1 | 并发多写下 materialized state 不损坏 | 并发测试 `lock-concurrency.test.ts` #1-#2 | 总方案 §7.1 #1 |
| 2 | `materializedHash` 始终与 findings 一致 | 并发测试 #1 断言 | 总方案 §7.1 #1 |
| 3 | 抢不到锁在 `timeoutMs` 后报错 | 单元测试 #2 | 总方案 §7.1 #2 |
| 4 | 陈旧锁被回收（超 staleMs） | 单元测试 #3 | 总方案 §7.1 #3 |
| 5 | rename 夺锁防双夺 | 单元测试 #4 | 总方案 §7.1 #4 |
| 6 | 临界区出口 fsync manifest + 目录 | 单元测试 #13 | 总方案 §7.1 #5 |
| 7 | 读路径无锁，hash 自检触发重试 | 单元测试 #11-#12 | 总方案 §7.1 #6 |
| 8 | `withMemoryLock` 异常时仍释锁 | 单元测试 #8 | 总方案 §7.2 #17 |
| 9 | 锁路径经 `assertSafePath` | 单元测试 #9 | 总方案 §7.2 #16 |
| 10 | 读路径重试有上限 | 单元测试 #12 | 总方案 §7.2 #20 |

### 11.2 回归验收

| # | 标准 | 验证方式 |
|---|---|---|
| 11 | 现有 1447 测试全绿 | `vitest run` |
| 12 | `npm run typecheck` 干净 | CI |
| 13 | 无新 npm 依赖 | `package.json` 不变 |
| 14 | `writeEventSegment` 不在锁内重复获锁（无嵌套锁死锁） | 代码审查：writeEventSegment 不调用 withMemoryLock |
| 15 | 不改动 `MemoryFindingSchema` / `MemoryEventSchema` | 代码审查 |

---

## 12. PR 结构（Commits）

```
1. feat(memory): add lock module with mkdir-based advisory write lock
   - src/memory/lock.ts: acquireMemoryLock / releaseMemoryLock / withMemoryLock
   - Atomic acquire via fs.mkdirSync, stale recovery via renameSync
   - assertSafePath on lock path

2. feat(fs-utils): add optional fsync to writeFileAtomicOverwrite
   - src/tools/fs-utils.ts: { fsync?: boolean } parameter
   - fsync file content + directory entry after rename

3. feat(memory/store): add hash self-check to readMaterializedState
   - Verify hashFindings(findings) === manifest.materializedHash
   - Single retry on mismatch, null on persistent inconsistency

4. feat(memory): wrap 4 write entry points with withMemoryLock
   - indexing.ts: lock around writeEventSegment + rebuild + write
   - mark.ts: lock around entire read-validate-write cycle
   - gc.ts: lock around read + delete + write cycle
   - compact.ts: lock around list + merge + writeCompacted + updateManifest
   - writeMaterializedState: pass { fsync: true } for manifest.json

5. test(memory): add lock unit tests and concurrency guards
   - test/memory/lock.test.ts: 15 unit tests
   - test/memory/lock-concurrency.test.ts: 4 concurrency tests
   - test/memory/_lock-worker.ts: worker process for fork-based tests

6. chore(paths): remove "Not yet implemented" comments from lock paths
```

---

## 13. 验证命令

```bash
# 全量类型检查
npm run typecheck

# 全量测试（1447 + 新增）
npx vitest run

# 仅锁测试
npx vitest run test/memory/lock.test.ts test/memory/lock-concurrency.test.ts

# 确认无锁残留
ls .omre/memory/locks/memory.lock 2>/dev/null && echo "LEAK" || echo "clean"
```

---

## 14. 风险与缓解

| 风险 | 可能性 | 影响 | 缓解 |
|---|---|---|---|
| `SharedArrayBuffer`/`Atomics.wait` 不可用（古早运行时） | 极低 | 锁等待退化 | Node 20+ 无条件支持 SAB；项目最低 Node 20，无 `--no-harmony` 限制；§4.2 sleepSync 已用 Atomics.wait（非 busy-wait） |
| 并发测试在 CI 环境下 flaky | 中 | 测试不稳定 | timeout 设宽裕（10s）+ 重试逻辑；如仍 flaky 可标记 `.concurrent` 或增加 staleMs |
| gc 锁持有时间过长（大仓库多文件删除） | 低 | 阻塞其他写入 | gc 是低频手动触发；deletions 本身是 O(n) unlink，N 通常 <100 |
| `readMaterializedState` 在锁外重试正好读到另一次写的中间态 | 极低 | 读到旧数据（非损坏） | 最终一致即可——读路径消费的状态本就可以是"上一轮"的快照 |
| Windows 上 `fs.mkdirSync` 行为差异 | 低 | 锁获取失败 | POSIX 保证；Windows NTFS 的 CreateDirectory 同样原子；集成测试覆盖 |
| `writeMaterializedState` 内 scanEventFiles 读全部事件文件，拉长锁持有 | 中 | 大仓库下写锁持有变长 | PR1 规模可接受；增量化记为 DEFERRED |
| 陈旧夺取后：(a) A release 误删 B 锁 + (b) A 恢复后继续写临界区（split-brain） | 极低 | 中（短暂双写窗口） | staleMs 60x 裕度使 (a)(b) 几乎不可达（正常写 <1s vs staleMs 60s）；若进程确实暂停>60s（SIGSTOP/swap thrash），steal 后 A 恢复并继续写是**已知边界**——无操作系统级 fencing 或心跳，无法完全消除。PR1 接受此边界因为：(1) CLI 工具非长驻服务；(2) memory state rebuild 幂等（rebuild 从全事件重算，双写最终收敛）；(3) 强化方案（flock/heartbeat/token）记为 DEFERRED，PR1 不实施 |
| 嵌套锁（`gc` 内部 `writeMaterializedState` 再获锁） | 不存在 | — | `withMemoryLock` 包裹最外层，内部调用不再获锁；`writeMaterializedState` 本身不获锁 |
| Windows 目录 fsync 不支持 | 低 | rename 持久化依赖 NTFS journal 而非显式 fsync | 用 try/catch best-effort；NTFS 在 flush metadata 时已持久 rename（journal write-ahead） |

---

## 15. 已关闭的债务

| 债务 | 来源 | 解决 |
|---|---|---|
| `paths.ts` "Not yet implemented" 注释 | STAGE_01 预留 | 本 PR 移除 |
| `writeFileAtomicOverwrite` 无 fsync | STAGE_01 已知弱点 | 本 PR 加可选 fsync |
| 读路径无一致性校验 | STAGE_01/02 已知 | 本 PR 加 hash 自检 |
| 四处写入口无互斥 | 总方案 §3.1 | 本 PR 全部包裹 |

---

## 16. 与总方案 §4.1 的对照

| 总方案 §4.1 要求 | 本细化方案对应 | 状态 |
|---|---|---|
| 锁路径 `.omre/memory/.lock` | 改为已预留的 `paths.lockFile`=`locks/memory.lock`（目录形态） | ✅ 兑现预留 |
| `fs.mkdir` 原子获取 | §4.2 `fs.mkdirSync(lockDir)` | ✅ |
| `owner.json` = `{ pid, hostname, acquiredAt }` | §4.2 `LockOwnerInfo` | ✅ |
| 有限阻塞轮询（~10s） | §2.3 `timeoutMs=10_000` | ✅ |
| 陈旧回收（~60s）+ rename 夺锁 | §2.3 `staleMs=60_000` + §4.2 `fs.renameSync` | ✅ |
| 出口 fsync manifest + 目录 | §7 `writeFileAtomicOverwrite({ fsync: true })` 仅 manifest | ✅ |
| 读路径 hash 校验重读 | §6 `readMaterializedState` + `hashFindings` 比对 | ✅ |
| 4 写入口用 `withMemoryLock` | §5.1-5.4 | ✅ |
| `writeEventSegment` 不锁 | §2.6 明确说明 | ✅ |
| 纯 Node 内置 / 零依赖 / 跨平台 | §4.1 仅 `node:fs` / `node:path` / `node:os` | ✅ |
| `assertSafePath` 校验锁路径 | §4.2 `assertSafePath(lockDir, paths.root, ...)` | ✅ |

---

## 17. 总方案勘误

在写细化方案时发现总方案 §4.1 写的锁路径是 `.omre/memory/.lock`，但代码预留的是 `.omre/memory/locks/memory.lock`。细化方案以**代码预留为准**（paths.ts:42 `lockFile: path.join(root, "locks", "memory.lock")`）。总方案待同步修正此路径。

同时，总方案 §2.2 提到"锁是新增的旁路文件（`.omre/memory/.lock`）"——也需同步更正为 `locks/memory.lock`。
