# rc-vscode — معماری سمت افزونه

چگونه `rc-vscode` را بازساخت کنیم تا قابلیت Velocity به آن اضافه شود، بدون بازنویسی بزرگ.

**نسخهٔ سند: v0.1**

> این سند مکمل [ARCHITECTURE-VELOCITY.md](./ARCHITECTURE-VELOCITY.md) است. آن سند دربارهٔ کل سیستم و daemon پایتون است؛ این یکی فقط دربارهٔ کد TypeScript خود افزونه.

---

## 0. حکم کلی

افزونه باید از «برنامه‌ای که مدل را صدا می‌زند» به **«کلاینت نازکی که یک پورت را صدا می‌زند»** تبدیل شود.

تمام هوشمندی (قواعد، بهینه‌سازی، Hydra، حالت) به daemon پایتون می‌رود. آنچه در TypeScript می‌ماند سه کار است و نه بیشتر:

1. UI و پروتکل webview
2. چرخهٔ حیات پروسه‌ها (daemon پایتون، سرورهای Node)
3. آداپتورهای VS Code (workspace، تنظیمات، توکن، ترمینال)

اما همین سه کار هم باید تمیز باشد، چون امروز نیست.

---

## 1. وضعیت امروز و چهار مشکل ساختاری

```
src/
├── extension.ts          46 خط   — ثبت فرمان‌ها
├── chatCommon.ts        ~430 خط  — ⚠ چهار مسئولیت در یک فایل
├── chatPanel.ts          40 خط
├── chatViewProvider.ts   50 خط
├── rcProcess.ts         ~520 خط  — ⚠ حل مسیر + spawn + kill + ساخت prompt
├── pairMode.ts          ~200 خط  — ⚠ حالت سراسری قابل‌نوشتن
├── terminalRunner.ts     70 خط
├── tokenSetup.ts        ~100 خط
└── prompts/pairMode.ts   25 خط
```

### مشکل ۱ — حالت سراسری مشترک، و یک باگ واقعی

```ts
// rcProcess.ts:393
let currentSession: PromptSession | undefined;
```

این متغیر سطح‌ماژول است، ولی **دو webview می‌توانند هم‌زمان باز باشند**: `rc.openChat` هم پنل ادیتور را باز می‌کند و هم سایدبار را reveal می‌کند.

نتیجه، دو رفتار غلط قابل بازتولید:

- `chatPanel.ts:31` در `onDidDispose` تابع `abortPlainPrompt()` را صدا می‌زند. بستن پنل ادیتور، **درخواست در حال اجرای سایدبار را می‌کشد.**
- `runPlainPrompt` در ابتدای خودش `currentSession` قبلی را می‌کشد. ارسال پیام از سایدبار، **پاسخ در حال تولید پنل را بی‌صدا قطع می‌کند.**

همین مشکل در `pairMode.ts` با `pairRunning` و `pendingUserNotes` هم هست.

**علت ریشه‌ای: مالکیت حالت در ماژول است، درحالی‌که باید در view باشد.**

### مشکل ۲ — `chatCommon.ts` چهار کار می‌کند

تولید HTML (۱۵۰ خط template literal)، مسیریابی پیام‌های webview، ارکستراسیون pair mode، و مدیریت خطای توکن. هر تغییری در هر کدام، فایل مشترک را لمس می‌کند.

### مشکل ۳ — پروتکل webview بدون تایپ

```ts
message as Record<string, unknown>
```
سپس تطبیق رشته‌ای با `if (type === "sendPrompt")`. سمت `media/chat.js` هم همان رشته‌ها دستی نوشته شده‌اند. هیچ چیزی این دو را همگام نگه نمی‌دارد.

### مشکل ۴ — معماری «همه‌یا‌هیچ» که مانع استریم است

```ts
child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
child.on("close", () => finish({ stdout: stdout.trim(), … }));
```

کل خروجی بافر می‌شود و یک‌جا با `postMessage({type:"assistant"})` فرستاده می‌شود. کاربر تا پایان کامل نوبت **هیچ‌چیز** نمی‌بیند.

این تنها مشکلی است که مستقیماً مانع بزرگ‌ترین برد Velocity (استریم SSE) می‌شود.

---

## 2. ساختار هدف

```
src/
├── extension.ts                 # ❶ فقط ریشهٔ ترکیب: می‌سازد، سیم می‌کشد، dispose می‌کند
│
├── core/                        # ❷ بدون import از vscode و بدون node/child_process
│   ├── ports.ts                 # PromptRunner, TurnSink, TokenStore,
│   │                            #   WorkspaceIndex, Transport, Logger, Clock
│   ├── protocol.ts              # اتحاد پیام‌های webview + PROTOCOL_VERSION
│   ├── types.ts                 # RunRequest, Delta, TurnEnd, Finding, HudModel
│   └── result.ts                # Result<T, E> — خطا بین لایه‌ها throw نمی‌شود
│
├── runner/                      # ❸ پیاده‌سازی‌های PromptRunner
│   ├── legacyRunner.ts          # همان spawn امروزی — یک delta بزرگ می‌دهد
│   ├── velocityRunner.ts        # HTTP + SSE به daemon پایتون
│   ├── fallbackRunner.ts        # دکوراتور: velocity، و در شکست ← legacy
│   └── index.ts
│
├── daemon/                      # ❹ چرخهٔ حیات پروسهٔ پایتون
│   ├── supervisor.ts            # spawn، کشف پورت، health، backoff، kill
│   ├── binaryResolver.ts        # قرینهٔ resolveNodePath(): bundled ← system ← هیچ
│   └── healthGate.ts            # مذاکرهٔ api_range
│
├── transport/
│   ├── httpClient.ts            # پوشش fetch با AbortSignal
│   └── sseReader.ts             # پارسر SSE ← AsyncIterable<ServerEvent>
│
├── chat/                        # ❺ جانشین chatCommon.ts
│   ├── router.ts                # نگاشت type ← handler. بدون هیچ منطق
│   ├── session.ts               # ⚠ حالت به‌ازای هر view: history، نوبت جاری، abort
│   └── handlers/
│       ├── sendPrompt.ts
│       ├── cancel.ts
│       ├── listFiles.ts
│       ├── token.ts
│       └── pair.ts
│
├── view/                        # ❻ تنها جایی که vscode.Webview را می‌شناسد
│   ├── html.ts                  # media/chat.html را می‌خواند و CSP و URI تزریق می‌کند
│   ├── sidebarView.ts           # جانشین chatViewProvider.ts
│   ├── editorPanel.ts           # جانشین chatPanel.ts
│   └── webviewSink.ts           # ⚠ TurnSink ← postMessage — پل استریم
│
├── platform/                    # ❼ آداپتورهای VS Code و سیستم‌عامل
│   ├── vscodeWorkspace.ts       # findFiles، cwd
│   ├── vscodeSettings.ts        # خواندن rc.*
│   ├── vscodeTokenStore.ts      # پوشش tokenSetup.ts
│   ├── nodeResolver.ts          # از rcProcess.ts بیرون کشیده می‌شود
│   └── processKill.ts           # از rcProcess.ts بیرون کشیده می‌شود
│
├── features/                    # ❽ اختیاری و خودثبت
│   ├── commit.ts
│   ├── terminal.ts
│   └── pair.ts                  # با حضور daemon، کلاینت hydra می‌شود
│
└── generated/
    └── velocityTypes.ts         # از openapi.json — هرگز دست‌نویس نیست
```

```
media/
├── chat.html                    # از دل chatCommon.ts بیرون کشیده شده
├── chat.css
└── ui/
    ├── protocol.js              # آینهٔ core/protocol.ts
    ├── stream.js                # ⚠ انباشت delta و رندر افزایشی
    ├── composer.js
    ├── picker.js
    └── hud.js
```

جهت وابستگی: **`core/` هیچ‌چیز را ایمپورت نمی‌کند. بقیه فقط `core/` را می‌بینند.** `platform/` و `view/` تنها لایه‌هایی هستند که اجازهٔ `import * as vscode` دارند.

---

## 3. سه درز کلیدی

### درز ۱ — `PromptRunner` و `TurnSink`

این مهم‌ترین تصمیم کل طراحی است.

```ts
// core/ports.ts — بدون هیچ import

export interface RunRequest {
  readonly text: string;
  readonly mode: "ask" | "write" | "auto";
  readonly history: readonly ChatTurn[];
  readonly search: boolean;
  readonly thinkingEffort: "off" | "low" | "medium" | "hard";
  readonly sessionKey: string;      // برای session_reuse سمت daemon
}

/** مقصد تکه‌های تولیدشده. UI هرگز نمی‌داند تولیدکننده چه بوده. */
export interface TurnSink {
  onStart(turnId: string): void;
  onDelta(d: { kind: "text" | "thinking"; text: string }): void;
  onEnd(e: { usage?: Usage; findings?: readonly Finding[] }): void;
  onError(message: string, kind?: "invalid_token" | "unavailable"): void;
}

export interface PromptRunner {
  readonly id: string;
  run(req: RunRequest, sink: TurnSink, signal: AbortSignal): Promise<void>;
}
```

**چرا این نکتهٔ اصلی است:** `legacyRunner` همان spawn امروزی را می‌کند و در پایان **یک** `onDelta` بزرگ می‌فرستد. `velocityRunner` صدها `onDelta` کوچک می‌فرستد.

از دید UI، این دو **یکسان‌اند**. یعنی:

> پس از این درز، افزودن استریم واقعی **هیچ خطی از کد UI را تغییر نمی‌دهد.**

و برعکس: اگر daemon نباشد، UI استریم‌محور با runner قدیمی هم درست کار می‌کند.

### درز ۲ — `fallbackRunner` به‌عنوان دکوراتور

```ts
// runner/fallbackRunner.ts
export function fallbackRunner(
  primary: PromptRunner,
  backup: PromptRunner,
  log: Logger,
): PromptRunner {
  return {
    id: `${primary.id}→${backup.id}`,
    async run(req, sink, signal) {
      const guard = firstDeltaGuard(sink);      // پس از اولین delta دیگر برنمی‌گردیم
      try {
        await primary.run(req, guard.sink, signal);
        return;
      } catch (err) {
        if (guard.emitted || signal.aborted) throw err;   // نیمه‌کاره تکرار نمی‌کنیم
        log.warn(`${primary.id} شکست خورد، بازگشت به ${backup.id}`, err);
      }
      await backup.run(req, sink, signal);
    },
  };
}
```

قید ایمنی مهم: اگر یک delta بیرون رفته باشد، **دوباره اجرا نمی‌کنیم** — وگرنه کاربر پاسخ را دوبار می‌بیند.

این همان اصل *Degrade, don't fail* است، به‌شکل یک دکوراتور بیست‌خطی. و «هرگز به‌خاطر Velocity شکست نخور» اینجا اجرا می‌شود، نه پراکنده در کد.

### درز ۳ — `ChatSession`: مالکیت حالت به‌ازای view

جانشین مستقیم متغیرهای سراسری، و رفع باگ بخش ۱.

```ts
// chat/session.ts
export class ChatSession implements Disposable {
  private turn?: { id: string; abort: AbortController };
  private readonly history: ChatTurn[] = [];
  readonly key = randomUUID();          // کلید نشست برای session_reuse

  constructor(private readonly runner: PromptRunner,
              private readonly sink: TurnSink) {}

  async send(req: Omit<RunRequest, "sessionKey" | "history">): Promise<void> {
    this.cancel();                       // فقط نوبت *خودش* را لغو می‌کند
    const abort = new AbortController();
    const id = randomUUID();
    this.turn = { id, abort };
    …
  }

  cancel(): void { this.turn?.abort.abort(); this.turn = undefined; }
  dispose(): void { this.cancel(); }
}
```

هر `sidebarView` و هر `editorPanel` **یک نمونهٔ خودش** را می‌سازد. بستن پنل فقط `dispose` خودش را می‌زند. باگ ساختاراً از بین می‌رود، نه با patch.

---

## 4. ریشهٔ ترکیب

`extension.ts` تنها جایی است که می‌داند پیاده‌سازی‌های واقعی چیستند. هیچ فایل دیگری وابستگی خودش را نمی‌سازد.

```ts
// extension.ts
export async function activate(ctx: vscode.ExtensionContext) {
  const log      = createLogger("RC");
  const settings = vscodeSettings();
  const tokens   = vscodeTokenStore(ctx);
  const workspace= vscodeWorkspace();
  const nodes    = nodeResolver(ctx.extensionPath);

  // همیشه موجود — رفتار امروزی
  const legacy = legacyRunner({ nodes, tokens, workspace, log });

  // اختیاری — فقط با فعال‌سازی کاربر
  let runner: PromptRunner = legacy;
  if (settings.get("velocity.enabled", false)) {
    const supervisor = createSupervisor({ ctx, settings, tokens, log });
    ctx.subscriptions.push(supervisor);
    const started = await supervisor.start();          // health + api_range
    if (started.ok) {
      runner = fallbackRunner(velocityRunner(started.value, log), legacy, log);
    } else {
      log.warn(`daemon بالا نیامد: ${started.error} — مسیر قدیمی فعال ماند`);
    }
  }

  const deps: ChatDeps = { runner, tokens, workspace, settings, log };

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("rc.chatView", sidebarView(ctx, deps),
      { webviewOptions: { retainContextWhenHidden: true } }),
    registerCommands(ctx, deps),
    registerFeatures(ctx, deps),   // commit، terminal، pair — خودثبت
  );
}
```

نکته: `activate` حالا `async` است، ولی `await supervisor.start()` **نباید فعال‌سازی را بلوکه کند**. پیاده‌سازی درست: `start()` بلافاصله برمی‌گردد و health را در پس‌زمینه چک می‌کند؛ تا آماده‌شدن، `fallbackRunner` خودش به legacy می‌افتد. اصل *Zero added latency* در goodcoder همین است.

---

## 5. پروتکل webview — تایپ‌دار و نسخه‌دار

```ts
// core/protocol.ts — تنها منبع حقیقت برای هر دو سمت
export const PROTOCOL_VERSION = 2;

export type ToExtension =
  | { type: "sendPrompt"; text: string; mode: AgentMode; search: boolean;
      thinkingEffort: ThinkingEffort; pair?: boolean; pairRounds?: number }
  | { type: "cancelPrompt" }
  | { type: "listFiles"; query: string }
  | { type: "saveToken"; token: string }
  | { type: "requestTokenSetup"; reason: "missing" | "expired" }
  | { type: "openDeepSeek" }
  | { type: "close" };

export type ToWebview =
  | { type: "ready"; protocol: number; runner: string; streaming: boolean }
  | { type: "turnStart"; turnId: string }
  | { type: "delta"; turnId: string; kind: "text" | "thinking"; text: string }
  | { type: "turnEnd"; turnId: string; usage?: Usage }
  | { type: "status"; text: string }
  | { type: "error"; text: string; kind?: "invalid_token" | "unavailable" }
  | { type: "cancelled" }
  | { type: "fileList"; entries: string[]; query: string }
  | { type: "tokenSetup"; … }
  | { type: "hud"; model: HudModel }          // جدید
  | { type: "finding"; finding: Finding };    // جدید
```

`router.ts` فقط نگاشت است، بدون منطق:

```ts
// chat/router.ts
const handlers: { [K in ToExtension["type"]]: Handler<K> } = {
  sendPrompt: handleSendPrompt,
  cancelPrompt: handleCancel,
  listFiles: handleListFiles,
  saveToken: handleSaveToken,
  requestTokenSetup: handleTokenSetup,
  openDeepSeek: handleOpenDeepSeek,
  close: handleClose,
};
```

نوع نگاشت `{ [K in ToExtension["type"]]: … }` تضمین می‌کند افزودن یک عضو به اتحاد **بدون handler، خطای کامپایل بدهد**. جای‌گزین تطبیق رشته‌ای امروز.

`media/ui/protocol.js` همان ثابت‌ها را نگه می‌دارد و `ready` نسخه‌ها را می‌سنجد؛ عدم تطابق ← بنر «افزونه را reload کن» به‌جای شکست بی‌صدا.

---

## 6. مسیر مهاجرت — پنج گام، هرکدام قابل انتشار

هیچ گامی رفتار کاربر را نمی‌شکند و هیچ‌کدام «بازنویسی بزرگ» نیست.

| گام | کار | تغییر رفتار | چرا اول این |
|---|---|---|---|
| **M0** | `core/ports.ts` و `core/result.ts` ساخته می‌شود؛ کد امروزی `rcProcess.ts` داخل `legacyRunner` بسته‌بندی می‌شود؛ `extension.ts` ریشهٔ ترکیب می‌شود | **هیچ** | فقط refactor. بعد از این، همه‌چیز پشت یک پورت است |
| **M1** | `chatCommon.ts` به `chat/router` و `chat/handlers/*` شکسته می‌شود؛ HTML به `media/chat.html` منتقل می‌شود؛ `ChatSession` جای متغیرهای سراسری را می‌گیرد | **رفع باگ** بخش ۱ | فایل ۴۳۰ خطی دیگر جلوی هر تغییری نمی‌ایستد |
| **M2** | `TurnSink` و `webviewSink` اضافه می‌شود؛ `legacyRunner` یک delta بزرگ می‌دهد؛ `media/ui/stream.js` رندر افزایشی می‌کند؛ پروتکل به v2 می‌رود | هیچ (از دید کاربر یکسان) | **گام کلیدی.** بعد از این، استریم واقعی صفر تغییر UI می‌خواهد |
| **M3** | `daemon/supervisor` و `transport/sse` و `velocityRunner` و `fallbackRunner`، پشت `rc.velocity.enabled` | استریم واقعی روشن می‌شود | برد ادراکی بزرگ (F6) |
| **M4** | `hud.js` و پیام‌های `finding`؛ Pair به کلاینت hydra تبدیل می‌شود | تشخیص و موازی‌سازی | ارزش افزوده، نه پیش‌نیاز |

**M2 نقطهٔ عطف است.** خیلی وسوسه‌انگیز است که مستقیم سراغ M3 بروی؛ نرو. اگر UI را قبل از آمدن daemon استریم‌محور نکنی، مجبور می‌شوی دو مسیر رندر موازی نگه داری و آن بدهی هرگز پرداخت نمی‌شود.

### نگاشت فایل‌های امروز

| فایل امروز | مقصد |
|---|---|
| `extension.ts` | `extension.ts` (فقط ترکیب) + `features/*` |
| `chatCommon.ts` — تولید HTML | `view/html.ts` + `media/chat.html` |
| `chatCommon.ts` — مسیریابی | `chat/router.ts` + `chat/handlers/*` |
| `chatCommon.ts` — ارکستراسیون pair | `features/pair.ts` |
| `chatCommon.ts` — خطای توکن | `platform/vscodeTokenStore.ts` + `chat/handlers/token.ts` |
| `chatPanel.ts` | `view/editorPanel.ts` |
| `chatViewProvider.ts` | `view/sidebarView.ts` |
| `rcProcess.ts` — حل مسیر node/cli | `platform/nodeResolver.ts` |
| `rcProcess.ts` — spawn و kill | `runner/legacyRunner.ts` + `platform/processKill.ts` |
| `rcProcess.ts` — ساخت prompt و mention | به daemon پایتون منتقل می‌شود؛ در legacy به‌عنوان پشتیبان می‌ماند |
| `pairMode.ts` | `features/pair.ts` (حالت به `ChatSession` منتقل می‌شود) |
| `terminalRunner.ts` | `features/terminal.ts` |
| `tokenSetup.ts` | `platform/vscodeTokenStore.ts` |
| `prompts/*` | به daemon پایتون منتقل می‌شود |

---

## 7. تطبیق پانزده ویژگی — سمت TypeScript

| # | ویژگی | تحقق در این ساختار |
|---|---|---|
| 1 | **Loose Coupling** | `core/` هیچ ایمپورتی ندارد؛ بقیه فقط آن را می‌بینند. مرز با پایتون HTTP است. `view/` هرگز runner را نمی‌سازد، تزریق می‌شود |
| 2 | **High Cohesion** | `daemon/` فقط چرخهٔ حیات، `transport/` فقط سیم، `chat/` فقط منطق گفت‌وگو، `view/` فقط VS Code |
| 3 | **Encapsulation** | `ChatSession` حالت را در نمونه حبس می‌کند. **تمام** `let`های سطح‌ماژول حذف می‌شوند |
| 4 | **Well-defined Interfaces** | `core/ports.ts` و `core/protocol.ts`. `generated/velocityTypes.ts` از OpenAPI ساخته می‌شود، نه دست |
| 5 | **Reusability** | چون `core/` و `runner/` و `transport/` به `vscode` وابسته نیستند، در تست node، در یک CLI، یا در پورت JetBrains بدون تغییر کار می‌کنند |
| 6 | **Replaceability** | `PromptRunner` سه پیاده‌سازی دارد (legacy / velocity / fallback). `TokenStore` و `WorkspaceIndex` هرکدام نسخهٔ fake دارند. تعویض = یک خط در `extension.ts` |
| 7 | **Independent Dev & Testing** | `ChatSession` با `fakeRunner` و `recordingSink` بدون VS Code و بدون spawn تست می‌شود. یک contract-test مشترک که هر سه runner باید از آن رد شوند |
| 8 | **Composability** | `fallbackRunner` دکوراتور است، نه شاخهٔ `if`. می‌شود زنجیر کرد: `retry(timeout(fallback(velocity, legacy)))` |
| 9 | **Maintainability & Extensibility** | افزودن یک پیام = یک عضو در اتحاد؛ **کامپایلر تا نوشتن handler خطا می‌دهد**. افزودن feature = یک فایل در `features/` |
| 10 | **Single Responsibility** | فایل ۴۳۰ خطی به هفت فایل تک‌کاره می‌شکند (جدول بخش ۶) |
| + | **Stateless** | `runner/`ها بی‌حالت‌اند: هر `run()` مستقل است و همهٔ حالت در `RunRequest` و `TurnSink` جریان دارد. تنها حالتِ ماندگار در `ChatSession` است، آن هم به‌ازای view |
| + | **Aspect-Oriented** | لاگ، تایم‌اوت، تلاش مجدد و سنجش، همگی دکوراتور روی `PromptRunner`اند؛ هیچ runnerی logger ندارد |
| + | **Fault Isolation** | سه مرز: `fallbackRunner` (شکست منطقی)، `supervisor` (شکست پروسه)، `Result<T,E>` (خطا بین لایه‌ها throw نمی‌شود). سقوط daemon فقط یعنی بازگشت به مسیر قدیمی |
| + | **Independent Versioning** | `PROTOCOL_VERSION` بین افزونه و webview؛ `api_range` بین افزونه و daemon. هر عدم تطابق ← تنزل کنترل‌شده، نه crash |
| + | **Discoverability** | `features/index.ts` آرایه‌ای از `FeatureModule` را export می‌کند و `registerFeatures` آن‌ها را می‌شمارد؛ `GET /velocity/modules` ماژول‌های daemon را برای HUD می‌آورد |

---

## 8. ریسک‌های همین بازساخت

| ریسک | شدت | مهار |
|---|---|---|
| M1 فایل ۴۳۰ خطی را می‌شکند و رگرسیون خاموش می‌دهد | بالا | قبل از M1، تست دود روی هر هفت پیام پروتکل بنویس؛ همان تست‌ها بعد از شکستن باید سبز بمانند |
| `fallbackRunner` پاسخ را دوبار نشان دهد | بالا | `firstDeltaGuard` — پس از اولین delta هرگز تکرار نمی‌شود (درز ۲) |
| `activate` با انتظار برای daemon کند شود | متوسط | `start()` غیرمسدودکننده؛ health در پس‌زمینه؛ تا آماده‌شدن، legacy پاسخ می‌دهد |
| ناهمگامی `protocol.ts` و `media/ui/protocol.js` | متوسط | مقایسهٔ `PROTOCOL_VERSION` در پیام `ready` و بنر reload؛ یا تولید فایل js از ts در build |
| رندر افزایشی markdown با کد ناقص بشکند | متوسط | delta را خام انباشته کن و رندر را throttle کن (مثلاً ۵۰ms)، نه به‌ازای هر delta |
| پروسهٔ یتیم پایتون پس از crash افزونه | بالا | فایل PID، heartbeat، و خودکشی daemon پس از N ثانیه بی‌کلاینتی |
