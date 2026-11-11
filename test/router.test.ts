/**
 * Headless checks for the router client half.
 *
 * There is no browser in this environment, so the test drives the real
 * `client.js` against a fake `window` (mutable location plus an entry stack)
 * and fake stores that mimic `ctx.layout.panelInfo` and the workspace
 * `selection` / `sessions.list` stores.
 *
 * Run: node --test test/router.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

/* -------------------------------------------------------------------- */
/* fake browser                                                          */
/* -------------------------------------------------------------------- */

/** @param initial - snapshot value @returns a minimal snapshot store */
function createStore(initial: any) {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => value,
		set(next: any) {
			value = next;
			for (const listener of [...listeners]) listener();
		},
		subscribe(listener: any) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
}

/** @param raw - absolute path @returns pathname / search / hash split */
function splitUrl(raw: any) {
	const url = new URL(raw, 'https://dsh-bot.example/');
	return { pathname: url.pathname, search: url.search, hash: url.hash };
}

/** @param pathname - path, search and hash @returns the joined URL */
function joinUrl({ pathname, search, hash }: { pathname: string, search: string, hash: string }) {
	return pathname + search + hash;
}

/**
 * One fake window with a history entry stack.
 * @param initial - opening URL.
 */
function createWindow(initial: any) {
	const entries = [{ url: initial, state: null }];
	let index = 0;
	const listeners = new Map();
	const location = splitUrl(initial);

	const current = () => entries[index];

	/** Put `location` on the entry the stack now points at. */
	const show = (url: any) => {
		const next = splitUrl(url);
		location.pathname = next.pathname;
		location.search = next.search;
		location.hash = next.hash;
	};

	const write = (state: any, raw: any, mode: any) => {
		const next = splitUrl(raw);
		show(next.pathname + next.search + next.hash);
		const entry = { url: joinUrl(next), state: state === void 0 ? null : state };
		if (mode === 'push') {
			entries.length = index + 1;
			entries.push(entry);
			index = entries.length - 1;
		} else entries[index] = entry;
	};

	const dispatch = (type: any) => {
		for (const listener of [...(listeners.get(type) ?? [])]) listener({ type });
	};

	/** Move through the stack the way the browser's Back / Forward would. */
	const go = (delta: any) => {
		const target = index + delta;
		assert.ok(target >= 0 && target < entries.length, 'history bound reached');
		index = target;
		show(current().url);
		dispatch('popstate');
		dispatch('hashchange');
	};

	const window = {
		location,
		history: {
			get state() {
				return current().state;
			},
			pushState(state: any, _title: any, raw: any) {
				write(state, raw, 'push');
			},
			replaceState(state: any, _title: any, raw: any) {
				write(state, raw, 'replace');
			},
			back() {
				go(-1);
			},
			forward() {
				go(1);
			}
		},
		addEventListener(type: any, listener: any) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(listener);
		},
		removeEventListener(type: any, listener: any) {
			listeners.get(type)?.delete(listener);
		}
	};

	return {
		window,
		url: () => joinUrl(location),
		entries: () => entries.map((entry) => entry.url),
		states: () => entries.map((entry) => entry.state),
		position: () => index,
		/** Simulate the browser Back button. */
		back() {
			go(-1);
		},
		/** Simulate a pasted URL (no Back button involved). */
		externalNavigate(raw: any) {
			const next = splitUrl(raw);
			show(joinUrl(next));
			dispatch('popstate');
			dispatch('hashchange');
		}
	};
}

/**
 * A fake page: one right column (the file / code preview), a set of modal
 * dialogs on top, and the core's document-level Escape handling.
 */
function createOverlayHost() {
	const dialogs : any[] = [];
	const escape : any[] = [];
	escape.push((event: any) => {
		if (event.key !== 'Escape') return false;
		const node = [...dialogs].reverse().find((dialog) => dialog.open);
		if (node === void 0 || node.ignoresEscape === true) return false;
		node.open = false;
		return true;
	});
	const sidebar = {
		expanded: false,
		isExpanded: () => sidebar.expanded,
		toggleExpanded() {
			sidebar.expanded = !sidebar.expanded;
		},
		openTabs: createStore([]),
		mounted: createStore(void 0)
	};
	const document = {
		visibilityState: 'visible',
		body: { nodeName: 'BODY' },
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent(event: any) {
			let handled = false;
			for (const listener of [...escape]) if (listener(event) === true) handled = true;
			return handled;
		},
		querySelectorAll() {
			return dialogs.filter((dialog) => dialog.open);
		}
	};
	const host = {
		document,
		sidebar,
		dialogs,
		/** The core closes the topmost dialog on a document-level Escape. */
		listenEscape(listener: any) {
			escape.push(listener);
		},
		openDialog(options: { ignoreEscape?: boolean, closeButton?: unknown } = {}) {
			const node = {
				open: true,
				ignoresEscape: options.ignoreEscape === true,
				closeButton: options.closeButton ?? null,
				getClientRects: () => [{ width: 1, height: 1 }],
				querySelector(selector: any) {
					return selector === 'button[aria-label]' ? node.closeButton : null;
				}
			};
			dialogs.push(node);
			return node;
		},
		/** The user closing the topmost dialog with its own control. */
		closeDialog() {
			const node = [...dialogs].reverse().find((dialog) => dialog.open);
			if (node !== void 0) node.open = false;
		},
		openCount: () => dialogs.filter((dialog) => dialog.open).length,
		/** The preview column becoming visible, as `openResource` does. */
		preview() {
			sidebar.expanded = true;
			sidebar.openTabs.set([{ sessionId: 'A', tabId: 'tab-1', kind: 'resource', contentId: '/a.ts' }]);
		},
		/** The preview column collapsing again through the app's own control. */
		dismissPreview() {
			sidebar.expanded = false;
			sidebar.openTabs.set(sidebar.openTabs.getSnapshot());
		},
		expanded: () => sidebar.expanded
	};
	return host;
}

/* -------------------------------------------------------------------- */
/* fake client runtime                                                   */
/* -------------------------------------------------------------------- */

/** Every booted environment, torn down after its case. */
const created : any[] = [];

let clock = 1_000_000;
Date.now = () => clock;
const advance = (ms: any) => {
	clock += ms;
};
/** Let the router's deferred sync run. */
const flush = async () => {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
};
/** Wait for real timers: the router debounces its DOM scans and close steps. */
const tick = async (ms = 120) => {
	await new Promise((resolve) => setTimeout(resolve, ms));
	await flush();
};

/**
 * Load `client.js` and apply it to a fake context.
 * @param options - opening URL, restored Session and catalog state.
 */
function boot(options: {
	sessions?: string[]
	url?: string
	overlay?: boolean
	expanded?: boolean
	phase?: string
	panels?: string[]
	restore?: string
} = {}) {
	const sessions = options.sessions ?? ['A', 'B'];
	const browser = createWindow(options.url ?? '/');
	globalThis.window = browser.window as unknown as Window & typeof globalThis;
	// Every case runs in the same realm, so the page is reset per boot.
	globalThis.document = undefined as unknown as Document;
	const host = options.overlay === true ? createOverlayHost() : void 0;
	if (host !== void 0) {
		globalThis.document = host.document as unknown as Document;
		(browser.window as { KeyboardEvent?: new (type: string, init?: object) => { type: string } }).KeyboardEvent = class FakeKeyboardEvent {
			type: string;
			constructor(type: string, init?: object) {
				Object.assign(this, init ?? {});
				this.type = type;
			}
		};
		if (options.expanded === true) host.preview();
	}

	let meta;
	(browser.window as { __ModuleLoader__?: { load: (value: { id: string, factory: (...args: unknown[]) => unknown }) => void } }).__ModuleLoader__ = { load: (value) => (meta = value) };
	vm.runInThisContext(`(() => { ${source} })();`, { filename: 'client.js' });
	assert.equal(meta!.id, '@thready-web/dsh-bot-plugin');
	const exported = meta!.factory(() => {
		throw new Error('the router must not require platform modules');
	});

	const panelInfo = createStore({ activePanelId: null });
	const selection = createStore({});
	const list = createStore({
		phase: options.phase ?? 'ready',
		ids: sessions,
		byId: Object.fromEntries(sessions.map((id) => [id, { id }]))
	});
	const panels = new Set(options.panels ?? ['ollama-usage', 'plugins']);
	const calls: { openSession: string[], selectPanel: string[] } = { openSession: [], selectPanel: [] };

	const layout = {
		panelInfo,
		hasMainPanel: (id: any) => panels.has(id),
		selectPanel(id: any) {
			if (id !== null && !panels.has(id)) throw new Error(`layout.selectPanel: main panel "${id}" is not registered`);
			calls.selectPanel.push(id);
			panelInfo.set({ activePanelId: id });
		}
	};

	const workspace = {
		selection,
		sessions: { list },
		openSession(id: any) {
			if (list.getSnapshot().byId[id] === undefined) throw new Error(`unknown Session ${id}`);
			calls.openSession.push(id);
			selection.set({ sessionId: id });
			// `replaceMain` reveals the conversation after selecting the Session.
			layout.selectPanel(null);
		}
	};

	const dispose : any[] = [];
	const ctx = {
		layout,
		uiWorkspace: workspace,
		/**
		 * The right column, which the preview lives in. Absent unless the case
		 * opts into an overlay host.
		 * @param name - service name.
		 */
		get(name: any) {
			if (host !== void 0 && name === 'sidebarRight') return host.sidebar;
			return void 0;
		},
		effect(factory: any) {
			const teardown = factory();
			if (typeof teardown === 'function') dispose.push(teardown);
			return teardown;
		}
	};

	// Some boots restore the persisted Session before plugins mount.
	if (options.restore !== undefined) selection.set({ sessionId: options.restore });

	exported.apply(ctx);

	const env = {
		...browser,
		host,
		ctx,
		exported,
		panelInfo,
		selection,
		list,
		calls,
		panels,
		/** The app restoring its persisted Session after the first paint. */
		restore(sessionId: any) {
			selection.set({ sessionId });
		},
		teardown: () => dispose.forEach((fn) => fn())
	};
	created.push(env);
	return env;
}

/* -------------------------------------------------------------------- */
/* runner                                                                */
/* -------------------------------------------------------------------- */

const cases : any[] = [];
const test = (name: any, run: any) => cases.push({ name, run });

test('exports the history policy and requires layout + uiWorkspace only', () => {
	const browser = createWindow('/');
	globalThis.window = browser.window as unknown as Window & typeof globalThis;
	let meta;
	(browser.window as { __ModuleLoader__?: { load: (value: { id: string, factory: (...args: unknown[]) => unknown }) => void } }).__ModuleLoader__ = { load: (value) => (meta = value) };
	vm.runInThisContext(`(() => { ${source} })();`, { filename: 'client.js' });
	const exported = meta!.factory(() => {
		throw new Error('no platform modules expected');
	});
	assert.deepEqual([...exported.inject].sort(), ['layout', 'uiWorkspace']);
	assert.equal(typeof exported.apply, 'function');
});

test('the restored Session is written with replaceState (no extra entry)', async () => {
	const env = boot({ url: '/' });
	env.restore('A');
	await flush();
	assert.equal(env.url(), '/#/s/A');
	assert.deepEqual(env.entries(), ['/#/s/A']);
});

test('opening a panel pushes an entry that Back pops', async () => {
	const env = boot({ url: '/', restore: 'A' });
	await flush();
	advance(5000);
	env.ctx.layout.selectPanel('ollama-usage');
	await flush();
	assert.equal(env.url(), '/#/s/A/p/ollama-usage');
	assert.deepEqual(env.entries(), ['/#/s/A', '/#/s/A/p/ollama-usage']);

	env.back();
	await flush();
	assert.equal(env.url(), '/#/s/A');
	assert.equal(env.panelInfo.getSnapshot().activePanelId, null);
	assert.equal(env.selection.getSnapshot().sessionId, 'A');
});

test('switching Session pushes an entry that Back pops', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A' });
	await flush();
	advance(5000);
	env.ctx.uiWorkspace.openSession('B');
	await flush();
	assert.equal(env.url(), '/#/s/B');
	assert.deepEqual(env.entries(), ['/#/s/A', '/#/s/B']);

	env.back();
	await flush();
	assert.equal(env.url(), '/#/s/A');
	assert.equal(env.selection.getSnapshot().sessionId, 'A');
	// Back must not append a corrective entry of its own.
	assert.deepEqual(env.entries(), ['/#/s/A', '/#/s/B']);
});

test('Back across a panel of another Session restores both', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A', panels: ['ollama-usage'] });
	await flush();
	advance(5000);
	env.ctx.layout.selectPanel('ollama-usage');
	await flush();
	env.ctx.uiWorkspace.openSession('B');
	await flush();
	assert.equal(env.url(), '/#/s/B');

	env.back();
	await flush();
	assert.equal(env.url(), '/#/s/A/p/ollama-usage');
	assert.equal(env.selection.getSnapshot().sessionId, 'A');
	assert.equal(env.panelInfo.getSnapshot().activePanelId, 'ollama-usage');
});

test('a deep link opens that Session and panel on load', async () => {
	const env = boot({ url: '/#/s/B/p/plugins', restore: 'A' });
	await flush();
	assert.equal(env.selection.getSnapshot().sessionId, 'B');
	assert.equal(env.panelInfo.getSnapshot().activePanelId, 'plugins');
	assert.equal(env.url(), '/#/s/B/p/plugins');
	assert.deepEqual(env.entries(), ['/#/s/B/p/plugins']);
});

test('the boot target is not re-asserted after the user moves away', async () => {
	const env = boot({ url: '/#/s/B/p/plugins', restore: 'A', sessions: ['A', 'B', 'C'] });
	await flush();
	assert.equal(env.selection.getSnapshot().sessionId, 'B');

	// Still inside the boot window, but this is a deliberate user action.
	env.ctx.uiWorkspace.openSession('C');
	await flush();
	assert.equal(env.selection.getSnapshot().sessionId, 'C');
	assert.equal(env.url(), '/#/s/C');
});

test('an unknown Session waits for the catalog, then falls back', async () => {
	const env = boot({ url: '/#/s/ZZZ', restore: 'A', phase: 'loading' });
	await flush();
	assert.equal(env.selection.getSnapshot().sessionId, 'A');
	assert.equal(env.url(), '/#/s/ZZZ');

	env.list.set({ ...env.list.getSnapshot(), phase: 'ready' });
	await flush();
	assert.equal(env.url(), '/#/s/A');
	assert.deepEqual(env.entries(), ['/#/s/A']);
});

test('repeated identical state does not grow the history stack', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A' });
	await flush();
	advance(5000);
	env.ctx.layout.selectPanel('ollama-usage');
	await flush();
	const before = env.entries().length;
	env.list.set({ ...env.list.getSnapshot() });
	env.selection.set({ sessionId: 'A' });
	env.panelInfo.set({ activePanelId: 'ollama-usage' });
	await flush();
	assert.equal(env.entries().length, before);
});

test('a hash without a Session segment leaves the Session alone', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A' });
	await flush();
	advance(5000);
	env.externalNavigate('/');
	await flush();
	assert.equal(env.selection.getSnapshot().sessionId, 'A');
});

test('an unregistered panel id is ignored and corrected away', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A' });
	await flush();
	advance(5000);
	env.externalNavigate('/#/s/A/p/missing');
	await flush();
	assert.equal(env.panelInfo.getSnapshot().activePanelId, null);
	assert.equal(env.selection.getSnapshot().sessionId, 'A');
	assert.equal(env.url(), '/#/s/A');
});

test('teardown removes the history listeners', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A' });
	await flush();
	advance(5000);
	env.teardown();
	env.externalNavigate('/#/s/B');
	await flush();
	assert.equal(env.selection.getSnapshot().sessionId, 'A');
});


test('opening a file preview pushes an entry that Back closes', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A', overlay: true });
	await flush();
	advance(5000);
	env.host!.preview();
	await tick();
	assert.equal(env.url(), '/#/s/A/o/1');
	assert.deepEqual(env.entries(), ['/#/s/A', '/#/s/A/o/1']);

	env.back();
	await tick(300);
	assert.equal(env.url(), '/#/s/A');
	assert.equal(env.host!.expanded(), false);
	assert.equal(env.selection.getSnapshot().sessionId, 'A');
	// Back must not leave a corrective entry of its own.
	assert.deepEqual(env.entries(), ['/#/s/A', '/#/s/A/o/1']);
});

test('closing the preview with the app control rewinds the URL', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A', overlay: true });
	await flush();
	advance(5000);
	env.host!.preview();
	await tick();
	assert.equal(env.url(), '/#/s/A/o/1');
	assert.equal(env.position(), 1);

	env.host!.dismissPreview();
	await tick(300);
	assert.equal(env.url(), '/#/s/A');
	assert.equal(env.position(), 0);
	assert.deepEqual(env.entries(), ['/#/s/A', '/#/s/A/o/1']);
});

test('opening and closing a preview repeatedly does not grow the stack', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A', overlay: true });
	await flush();
	advance(5000);
	env.host!.preview();
	await tick();
	env.host!.dismissPreview();
	await tick(300);
	assert.deepEqual(env.entries(), ['/#/s/A', '/#/s/A/o/1']);

	env.host!.preview();
	await tick(300);
	assert.equal(env.url(), '/#/s/A/o/1');
	assert.equal(env.position(), 1);
	assert.deepEqual(env.entries(), ['/#/s/A', '/#/s/A/o/1']);
});

test('a modal dialog gets an entry that Back closes', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A', overlay: true });
	await flush();
	advance(5000);
	env.host!.openDialog();
	await tick(600);
	assert.equal(env.host!.openCount(), 1);
	assert.equal(env.url(), '/#/s/A/o/1');
	assert.deepEqual(env.entries(), ['/#/s/A', '/#/s/A/o/1']);

	env.back();
	await tick(300);
	assert.equal(env.url(), '/#/s/A');
	assert.equal(env.host!.openCount(), 0);
	assert.deepEqual(env.entries(), ['/#/s/A', '/#/s/A/o/1']);
});

test('a modal that ignores Escape is closed through its close button', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A', overlay: true });
	await flush();
	advance(5000);
	const node = env.host!.openDialog({ ignoreEscape: true });
	node.closeButton = {
		click() {
			node.open = false;
		}
	};
	await tick(600);
	assert.equal(env.url(), '/#/s/A/o/1');

	env.back();
	await tick(400);
	assert.equal(env.url(), '/#/s/A');
	assert.equal(env.host!.openCount(), 0);
});

test('stacked overlays peel off one Back press at a time', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A', overlay: true });
	await flush();
	advance(5000);
	env.host!.preview();
	await tick();
	env.host!.openDialog();
	await tick(600);
	assert.equal(env.url(), '/#/s/A/o/2');
	assert.deepEqual(env.entries(), ['/#/s/A', '/#/s/A/o/1', '/#/s/A/o/2']);

	env.back();
	await tick(400);
	assert.equal(env.url(), '/#/s/A/o/1');
	assert.equal(env.host!.openCount(), 0);
	assert.equal(env.host!.expanded(), true);
});

test('a preview over an open panel keeps both, and Back peels the preview first', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A', overlay: true });
	await flush();
	advance(5000);
	env.ctx.layout.selectPanel('ollama-usage');
	await flush();
	assert.equal(env.url(), '/#/s/A/p/ollama-usage');

	env.host!.preview();
	await tick();
	assert.equal(env.url(), '/#/s/A/p/ollama-usage/o/1');

	env.back();
	await tick(300);
	assert.equal(env.url(), '/#/s/A/p/ollama-usage');
	assert.equal(env.host!.expanded(), false);
	assert.equal(env.panelInfo.getSnapshot().activePanelId, 'ollama-usage');

	env.back();
	await tick();
	assert.equal(env.url(), '/#/s/A');
	assert.equal(env.panelInfo.getSnapshot().activePanelId, null);
});

test('an overlay already open on load is written into the URL', async () => {
	const env = boot({ url: '/#/s/A', restore: 'A', overlay: true, expanded: true });
	await flush();
	assert.equal(env.url(), '/#/s/A/o/1');
	assert.deepEqual(env.entries(), ['/#/s/A/o/1']);
});

test('an overlay segment in a deep link is dropped when nothing is open', async () => {
	const env = boot({ url: '/#/s/A/o/1', restore: 'A', overlay: true });
	await flush();
	assert.equal(env.url(), '/#/s/A');
	assert.deepEqual(env.entries(), ['/#/s/A']);
});

let failures = 0;
for (const { name, run } of cases) {
	try {
		await run();
		console.log(`ok - ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`not ok - ${name}`);
		const stack = error instanceof Error ? error.stack : undefined;
		console.log(String(stack ?? error).replace(/^/gm, '    '));
	} finally {
		for (const env of created.splice(0)) env.teardown();
		globalThis.document = undefined as unknown as Document;
	}
	clock += 10_000;
}
console.log(failures === 0 ? `router: ok (${cases.length} cases)` : `router: ${failures} failed of ${cases.length}`);
process.exitCode = failures === 0 ? 0 : 1;
