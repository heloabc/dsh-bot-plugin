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

DSH loads `dist/`. Rebuild after changing `src/`. Until `npm --prefix ui run build` has run, `/dsh-bot/` is 404.

Host integration needs Node `>= 24.9` and `DSH_BIN`:

```bash
npm run test:host
```
