# @thready-web/dsh-bot-plugin

Cordis plugin for the DSH bot. `@thready-web/dsh-bot` is the launcher that starts DSH with this plugin already inserted. Install this package into a profile only when you are assembling DSH yourself.

| Entry | Role |
| --- | --- |
| `@thready-web/dsh-bot-plugin` | Persona, memory, skills, work, and inbox |
| `@thready-web/dsh-bot-plugin/http` | `/dsh-bot/api/*` (same routes as `/session-foundations/api/*`) and the workbench at `/dsh-bot/` |
| `@thready-web/dsh-bot-plugin/router` | Hash routing for the official web client |
| `@thready-web/dsh-bot-plugin/cli` | Admin commands. The `dsh-bot` binary calls this. |

Prompts, tool descriptions, and API messages are English. A stored persona may still start with a legacy CJK name label. New persona text uses `Name:`, `Style:`, and `Task:`. The workbench defaults to English. The language control switches the whole UI through the message catalog in `ui/src/i18n.ts`.

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

## Session working directory

Workbench sessions start in `THREADY_SESSION_CWD` when set, otherwise in `<DSH_HOME>/workspace` (created on first use), never in `DSH_HOME` itself, which holds the owner token and profiles.

DSH loads `dist/`. Rebuild after changing `src/`. Until `npm --prefix ui run build` has run, `/dsh-bot/` is 404.

Host integration needs Node `>= 24.9` and `DSH_BIN`:

```bash
npm run test:host
```
