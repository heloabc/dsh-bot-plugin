# @thready-web/dsh-bot-plugin

Cordis plugin for the DSH bot. `@thready-web/dsh-bot` is the launcher that starts DSH with this plugin already inserted. Install this package into a profile only when you are assembling DSH yourself.

| Entry | Role |
| --- | --- |
| `@thready-web/dsh-bot-plugin` | Persona, memory, skills, work, and inbox |
| `@thready-web/dsh-bot-plugin/http` | `/dsh-bot/api/*` (same routes as `/session-foundations/api/*`) and the workbench at `/dsh-bot/` |
| `@thready-web/dsh-bot-plugin/router` | Hash routing for the official web client |
| `@thready-web/dsh-bot-plugin/cli` | Admin commands. The `dsh-bot` binary calls this. |

Prompts, tool descriptions, and API messages are English. A stored persona may still start with a legacy CJK name label. New persona text uses `Name:`, `Style:`, and `Task:`. The workbench defaults to English. The language control switches the whole UI through the message catalog in `ui/src/i18n/`.

```bash
npm install
npm test
npm run build
npm --prefix ui install
npm --prefix ui run build
```

DSH itself is not in this package. Running a host needs `@deepseek-ai/dsh@0.2.2-rc.1` and Node.js `>= 24.9`. Plugin unit tests run on Node `>= 22.18`.

In `cordis.patch.yml` every new entry must be wrapped in `- insert:`:

```yaml
- insert:
    - id: ui-router
      name: "@thready-web/dsh-bot-plugin/router"
- insert:
    - id: session-foundations
      name: "@thready-web/dsh-bot-plugin"
- insert:
    - id: session-foundations-http
      name: "@thready-web/dsh-bot-plugin/http"
```

Start the host with `dsh --profile <name> --host 127.0.0.1 --port <port> --no-open` after the patch lists these entries. The official client is `/`. The workbench is `/dsh-bot/`. From the `dsh-plugins` repository, `npx dsh-bot` writes that patch and starts the process.

## Main-session budget

A bot main session may do the work itself (bash, write, ...) or hand it to a worker with `foundations_dispatch`. The host keeps a runaway guard on each main turn:

| Field | Default | Meaning |
| --- | --- | --- |
| `chatMaxSteps` / `chatWallMs` | 80 / 30 min | Cap for every main turn |
| `mainMaxSteps` / `mainWallMs` | 80 / 30 min | Cap after a dispatch or a host tool. It can only tighten the chat cap; with the defaults it changes nothing. Set it lower to push long work onto workers. |

- The step cap is checked in `agent/pre-step`: the next step is refused and the turn ends `blocked`. A step that already ended is never cancelled, so a turn whose last step answered the user ends `completed`.
- The wall cap stops a still-running step with `agent.cancel({ kind: 'hook', reason: 'main-budget:wall' })`. Host cancels never use `{ kind: 'user' }` (worker caps use `worker-budget:*`, ticket cancels `ticket-cancel`).
- Each trip is written to stderr (`session-foundations: main budget main-budget:steps session=… turn=… steps=…`) and posts one `[foundations:budget]` next-turn message. The model then tells the user the turn was cut off and may dispatch the rest to a worker. Set `budgetNotice: false` to skip the message.

Override in the patch (`config.work`) or with the `DSH_BOT_WORK_BUDGET` environment variable (the launcher's `--work-budget`). Config wins over the environment. Both accept `steps` / `wall` shorthands and duration strings:

```yaml
- insert:
    - id: session-foundations
      name: "@thready-web/dsh-bot-plugin"
      config:
        work: { steps: 120, wall: 45m }
```

```bash
DSH_BOT_WORK_BUDGET='steps=120,wall=45m,mainMaxSteps=10'
```

## Worker slots and queue

Each bot may run more than one worker at a time. These four fields are formal budget keys, not source-only constants. They reach the scheduler through the same path as the main-session caps: plugin `config.work`, then `DSH_BOT_WORK_BUDGET` (the launcher `--work-budget`), then the defaults below.

| Field | Default | Max | Meaning |
| --- | --- | --- | --- |
| `perBot` / `global` | 2 / 4 | 64 | Running slots: `enqueued`, `started`, or a reserved start. A ticket in `needs_user` does not occupy a slot unless a resume has already reserved one. |
| `perBotQueue` / `globalQueue` | 8 / 16 | 256 | Accepted tickets waiting for a slot. When both the slot cap and the matching queue cap are full, `foundations_dispatch` returns `BUDGET` and inserts no row. |

`perBot` and `perBotQueue` must be positive integers. Values that are missing, zero, negative, non-integer, infinite, or unknown are ignored and the default is kept — a typo never raises a cap to infinity. Values above the max are clamped to the max and logged. If `perBot` is greater than `global`, the effective running cap for one bot is `min(perBot, global)`. The same rule applies to the queue caps. The configured numbers are kept as written; only admission uses the effective minimum, and startup logs it.

Limits are read when the work runtime is created (process start or plugin load). They are not hot-reloaded into a process that is already running. After a restart with a lower cap, workers that are already running are not cancelled; later `foundations_dispatch` and queue promotion use the new caps.

When a running ticket completes, fails, is cancelled, or parks in `needs_user`, the oldest waiting ticket that still fits the caps starts automatically (global FIFO by `created_at`, then insertion order). First-phase scheduling is not a weighted fair share across bots.

Parked `needs_user` tickets still count toward the combined unfinished cap (`slots + queue`), so they cannot grow without bound or block every new dispatch by filling running slots. Idempotent dispatch of the same owner and key replays the existing ticket.

Workers share the owner's workspace. There is no filesystem isolation; briefings should state file boundaries, or dependent work should stay serial.

Workers use the `foundations-files` preset: official file tools plus official `@deepseek-ai/dsh-tool-bash` and `@deepseek-ai/dsh-tool-jobs`. The host sandbox stays `workspace-write` with the existing approval policy. This does not mount the web preset, add writable roots, or switch the sandbox to `danger-full-access`. A reserved start that does not create a worker within `min(ticket wallMs, 10m)` fails with `reserve-wall` and frees the slot; a late `createChild` is cancelled instead of attached.

Runnable examples (any one of these is enough; `config.work` wins over the environment):

```yaml
# DSH patch, under the session-foundations plugin
- insert:
    - id: session-foundations
      name: "@thready-web/dsh-bot-plugin"
      config:
        work:
          perBot: 3
          global: 6
          perBotQueue: 8
          globalQueue: 16
```

```bash
# Environment the plugin reads directly
DSH_BOT_WORK_BUDGET='perBot=3,global=6,perBotQueue=8,globalQueue=16'

# Same text through the launcher (also accepts JSON)
dsh-bot start --work-budget perBot=3,global=6,perBotQueue=8,globalQueue=16
dsh-bot start --work-budget '{"perBot":1,"global":4}'
```

`perBot` and `global` are already on the published launcher `--work-budget` allowlist. `perBotQueue` and `globalQueue` need a launcher that includes those keys; until then set the queue caps in `config.work` or `DSH_BOT_WORK_BUDGET` when starting `dsh` without the launcher flag.

## Session working directory

Workbench sessions start in `THREADY_SESSION_CWD` when set, otherwise in `<DSH_HOME>/workspace` (created on first use), never in `DSH_HOME` itself, which holds the owner token and profiles.

Generated raster previews can be embedded at `/dsh-bot/<project>/preview/<image>` or `/dsh-bot/<project>/artifacts/<image>`. These are deliberate artifact directories under that configured workspace, not a general file server or a per-session sharing boundary: authenticated workbench users can view their images. Only JPEG, PNG, GIF and WebP with matching signatures are served, with private/no-store caching. Dotfiles, traversal, symlink escapes, other workspace locations and active HTML/SVG are rejected. With no configured workspace this fallback is disabled. Relative Markdown image paths resolve under `/dsh-bot/`; existing absolute URLs remain unchanged.

Markdown images use bounded, aspect-preserving thumbnails. Click to open a viewport-fit dialog, then choose Original size to scroll through screenshot details. Escape, the close button or the backdrop dismisses it, restoring focus and body scrolling. Linked images expose their link separately from the preview control. Preview and unavailable-state labels follow the English/Chinese UI catalog.

A failed thumbnail or viewer image is removed and replaced with a neutral unavailable message and an explicit Retry image button; status/interaction polling does not retry it. Markdown renderer identities stay stable when file callbacks or streaming state change. Failure memory belongs to the current mounted session view (up to 128 URLs, each at most 4096 characters), not global state or browser storage; mounted images also retain local failure state. Session navigation/reload clears it. A cache-evicted image can be attempted again if later remounted. Nothing restores deleted workspace files or retains artifact copies.

Actions folds keep their initial view until the user toggles them. Streaming updates, new actions, live-to-durable event replacement and completion do not automatically open or close an existing fold. Text and question boundaries still separate action groups in transcript order.


DSH loads `dist/`. Rebuild after changing `src/`. Until `npm --prefix ui run build` has run, `/dsh-bot/` is 404.

Host integration needs Node `>= 24.9` and `DSH_BIN`:

```bash
npm run test:host
```
