/**
 * Client half of the DSH Web router plugin.
 *
 * DSH keeps the active Session, the open main panel and the overlays on top of
 * them (the right column with the file / code preview, and any modal dialog) in
 * memory only, so the browser Back button leaves the page instead of walking
 * the app's own navigation. This plugin adds the missing URL layer without
 * touching the core frontend bundle:
 *
 *  - the active Session, the open main panel and the number of stacked
 *    overlays are mirrored into `location.hash` as
 *    `#/s/<sessionId>/p/<panelId>/o/<depth>` (every segment optional);
 *  - user-driven switches `pushState` a new entry, so Back returns to the
 *    previous Session, closes the open panel, or closes the overlay on top;
 *  - `popstate` / `hashchange` read the hash back: a lower overlay depth closes
 *    the overlays instead of leaving the page, and the rest drives the same
 *    services the UI itself uses (`ctx.layout.selectPanel`,
 *    `ctx.uiWorkspace.openSession`);
 *  - closing an overlay with the app's own close control steps the browser
 *    history back, so the URL never keeps a dead entry for it;
 *  - a deep link (page load or reload with a hash) is adopted once the Session
 *    catalog is ready, so a shared URL opens the same view.
 *
 * Bundled for the DSH client loader; no rendering, no slots.
 */
window.__ModuleLoader__.load({
	id: '@thready-web/dsh-bot-plugin',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		/** Hash segment naming a Session. */
		const SEG_SESSION = 's';
		/** Hash segment naming a main panel. */
		const SEG_PANEL = 'p';
		/** Hash segment naming how many overlays are stacked above the view. */
		const SEG_OVERLAY = 'o';
		/** How long after a history event echoes are folded into `replaceState`. */
		const SETTLE_MS = 1500;
		/**
		 * How long a deep link keeps reasserting itself while the app boots. The
		 * workspace restores its persisted Session asynchronously once both the
		 * Workspace and Session catalogs are ready, which over a slow link can
		 * take a few seconds.
		 */
		const BOOT_MS = 8000;
		/** Attempts allowed per deep-link segment before it is abandoned. */
		const BOOT_TRIES = 3;
		/** The core's own modal dialogs: a portal on `body`, topmost last. */
		const DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';
		/** Overlay depth is capped so a runaway stack cannot fill the address bar. */
		const MAX_OVERLAY = 9;
		/** A batch of DOM mutations settles this long before the overlay is measured. */
		const SCAN_DEBOUNCE_MS = 80;
		/** Fallback poll for overlay changes no mutation reports (column expansion). */
		const SCAN_INTERVAL_MS = 350;
		/** One overlay close gets this long to commit before the next step. */
		const CLOSE_STEP_MS = 40;
		/** Close steps allowed for one Back press. */
		const CLOSE_TRIES = 12;
		/** Our own `history.back()` gets this long to land before it is given up on. */
		const BACK_MS = 1200;
		/** Key of the marker this plugin keeps in `history.state`. */
		const STATE_KEY = '__dshUiRouter';

		/**
		 * @param value - value to escape.
		 * @returns the escaped segment.
		 */
		function encodeSegment(value) {
			try {
				return encodeURIComponent(value);
			} catch (_error) {
				return value;
			}
		}

		/**
		 * @param value - escaped segment.
		 * @returns the decoded segment.
		 */
		function decodeSegment(value) {
			try {
				return decodeURIComponent(value);
			} catch (_error) {
				return value;
			}
		}

		/**
		 * Read a route out of a location hash.
		 * @param hash - `location.hash`, with or without the leading `#`.
		 * @returns the session id (undefined when absent), the panel id (null when
		 * absent) and the overlay depth (0 when absent).
		 */
		function parseHash(hash) {
			const route = { sessionId: void 0, panelId: null, overlay: 0 };
			if (typeof hash !== 'string' || hash.length === 0) return route;
			const parts = hash
				.replace(/^#/, '')
				.split('/')
				.filter((segment) => segment.length > 0)
				.map(decodeSegment);
			for (let index = 0; index + 1 < parts.length; index += 2) {
				const key = parts[index];
				const value = parts[index + 1];
				if (key === SEG_SESSION && value.length > 0) route.sessionId = value;
				else if (key === SEG_PANEL && value.length > 0) route.panelId = value;
				else if (key === SEG_OVERLAY) {
					const depth = Number.parseInt(value, 10);
					if (Number.isFinite(depth) && depth > 0) route.overlay = Math.min(depth, MAX_OVERLAY);
				}
			}
			return route;
		}

		/**
		 * @param route - session id, panel id and overlay depth.
		 * @returns the hash for that route, empty when nothing is addressable.
		 */
		function formatHash(route) {
			const segments = [];
			if (typeof route.sessionId === 'string' && route.sessionId.length > 0) segments.push(SEG_SESSION, encodeSegment(route.sessionId));
			if (typeof route.panelId === 'string' && route.panelId.length > 0) segments.push(SEG_PANEL, encodeSegment(route.panelId));
			if (typeof route.overlay === 'number' && route.overlay > 0) segments.push(SEG_OVERLAY, String(Math.min(route.overlay, MAX_OVERLAY)));
			return segments.length === 0 ? '' : '#/' + segments.join('/');
		}

		/** Services required from the client runtime. */
		exports.inject = ['layout', 'uiWorkspace'];

		/**
		 * Mirror the active Session, main panel and overlay stack into the URL and
		 * drive them from it.
		 * @param ctx - client plugin context.
		 */
		function apply(ctx) {
			if (typeof window === 'undefined' || window.location === void 0 || window.history === void 0) return;
			const location = window.location;
			const history = window.history;

			const layout = ctx.layout;
			const workspace = ctx.uiWorkspace;
			const panelInfo = layout.panelInfo;
			const selection = workspace.selection;
			const sessionList = workspace.sessions.list;

			/** The route the page was opened with; consumed one item at a time. */
			const boot = parseHash(location.hash);
			let bootSession = boot.sessionId;
			let bootPanel = boot.panelId;
			const bootUntil = Date.now() + BOOT_MS;
			let sessionTries = 0;
			let panelTries = 0;
			/** False until the boot route has been applied (or given up on). */
			let live = false;
			/** Echoes until this timestamp rewrite the URL in place. */
			let settleUntil = Date.now() + SETTLE_MS;
			/** A deferred `sync` is pending. */
			let queued = false;
			/** Overlay depth the current history entry is believed to describe. */
			let publishedOverlay = boot.overlay;
			/** Non-zero while our own `history.back()` is in flight. */
			let backAt = 0;
			/** Overlay depth a Back press asked for, while the closes run. */
			let settleTarget = null;
			/** Pending debounced overlay scan. */
			let scanTimer = 0;

			/** @returns the current app route. */
			const readRoute = () => ({
				sessionId: selection.getSnapshot().sessionId,
				panelId: panelInfo.getSnapshot().activePanelId
			});

			const currentUrl = () => location.pathname + location.search + location.hash;

			/**
			 * @param route - target route.
			 * @returns the absolute URL for it, keeping path and query.
			 */
			const urlFor = (route) => location.pathname + location.search + formatHash(route);

			/** @returns the right-column service, or undefined when it is not mounted. */
			const sidebarRight = () => {
				if (typeof ctx.get !== 'function') return void 0;
				try {
					return ctx.get('sidebarRight');
				} catch (_error) {
					return void 0;
				}
			};

			/** @returns the marker this plugin left on the current history entry. */
			const entryTag = () => {
				let state;
				try {
					state = history.state;
				} catch (_error) {
					return void 0;
				}
				if (state === null || typeof state !== 'object') return void 0;
				const tag = state[STATE_KEY];
				return tag !== null && typeof tag === 'object' ? tag : void 0;
			};

			/**
			 * @param tag - marker to record.
			 * @returns the state object to write, keeping whatever the page already stored.
			 */
			const withTag = (tag) => {
				let state;
				try {
					state = history.state;
				} catch (_error) {
					state = null;
				}
				const base = state !== null && typeof state === 'object' ? { ...state } : {};
				base[STATE_KEY] = tag;
				return base;
			};

			/**
			 * Write the route into the address bar.
			 * @param route - route to publish.
			 * @param mode - `push` for a new entry, `replace` to rewrite in place.
			 * @param kind - why the entry exists: `overlay` for one this plugin opened
			 * for an overlay, `route` for a Session / panel move or a rewrite.
			 */
			const publish = (route, mode, kind) => {
				publishedOverlay = route.overlay;
				const url = urlFor(route);
				if (url === currentUrl()) return;
				const state = withTag({ kind, depth: route.overlay });
				try {
					if (mode === 'replace') history.replaceState(state, '', url);
					else history.pushState(state, '', url);
				} catch (_error) {
					/* History may be unavailable in a sandboxed frame; the app still works. */
				}
			};

			/** @returns the dialogs the core currently shows, topmost last. */
			const visibleDialogs = () => {
				if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return [];
				let nodes;
				try {
					nodes = document.querySelectorAll(DIALOG_SELECTOR);
				} catch (_error) {
					return [];
				}
				const open = [];
				for (let index = 0; index < nodes.length; index += 1) {
					const node = nodes[index];
					if (node === null || node === void 0) continue;
					// A dialog kept mounted while hidden is not an overlay.
					if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) continue;
					open.push(node);
				}
				return open;
			};

			/** @returns whether the right column is showing its panel. */
			const sidebarExpanded = () => {
				const sidebar = sidebarRight();
				if (sidebar === void 0 || typeof sidebar.isExpanded !== 'function') return false;
				try {
					return sidebar.isExpanded() === true;
				} catch (_error) {
					return false;
				}
			};

			/**
			 * Count what is stacked above the plain view: every modal dialog, plus
			 * the right column (the file / code preview lives there) when expanded.
			 * @returns the overlay depth, 0 for a bare view.
			 */
			const overlayDepth = () => Math.min(visibleDialogs().length + (sidebarExpanded() ? 1 : 0), MAX_OVERLAY);

			/**
			 * Send the core's own Escape handling to the topmost modal, which is what
			 * its dialog stack listens for.
			 * @returns whether an event could be dispatched.
			 */
			const pressEscape = () => {
				if (typeof document === 'undefined' || typeof document.dispatchEvent !== 'function') return false;
				const ctor =
					typeof window.KeyboardEvent === 'function'
						? window.KeyboardEvent
						: typeof KeyboardEvent === 'function'
							? KeyboardEvent
							: void 0;
				if (ctor === void 0) return false;
				let event;
				try {
					event = new ctor('keydown', {
						key: 'Escape',
						code: 'Escape',
						keyCode: 27,
						which: 27,
						bubbles: true,
						cancelable: true
					});
				} catch (_error) {
					return false;
				}
				try {
					document.dispatchEvent(event);
					return true;
				} catch (_error) {
					return false;
				}
			};

			/**
			 * Ask the dialog's own close affordances, for a modal that ignores Escape.
			 * @param dialog - the topmost dialog.
			 * @returns whether something was clicked.
			 */
			const clickDialogClose = (dialog) => {
				if (typeof dialog.querySelector !== 'function') return false;
				const candidates = ['button[aria-label]', '.mask'];
				for (const selector of candidates) {
					let node;
					try {
						node = dialog.querySelector(selector);
					} catch (_error) {
						continue;
					}
					if (node !== null && node !== void 0 && typeof node.click === 'function') {
						try {
							node.click();
							return true;
						} catch (_error) {
							/* Keep to the next affordance. */
						}
					}
				}
				return false;
			};

			/**
			 * Close whatever is on top: the last modal first, then the right column.
			 * @param control - true to use the dialog's own close control instead of
			 * sending Escape, for a modal that does not take the key.
			 * @returns whether a close was requested.
			 */
			const closeTopOverlay = (control) => {
				const dialogs = visibleDialogs();
				if (dialogs.length > 0) {
					if (!control && pressEscape()) return true;
					return clickDialogClose(dialogs[dialogs.length - 1]);
				}
				if (sidebarExpanded()) {
					const sidebar = sidebarRight();
					try {
						sidebar.toggleExpanded();
						return true;
					} catch (_error) {
						return false;
					}
				}
				return false;
			};

			/**
			 * @param sessionId - candidate Session id.
			 * @returns whether the catalog already knows that Session.
			 */
			const knownSession = (sessionId) => {
				const snapshot = sessionList.getSnapshot();
				return snapshot !== void 0 && snapshot.byId !== void 0 && snapshot.byId[sessionId] !== void 0;
			};

			/** @returns whether the Session catalog has finished its first load. */
			const catalogReady = () => {
				const snapshot = sessionList.getSnapshot();
				return snapshot !== void 0 && snapshot.phase === 'ready';
			};

			/**
			 * Apply one pending piece of the boot route. A segment is only dropped
			 * once the app actually shows it, because the workspace restore runs
			 * after this plugin mounts and may briefly override both.
			 * @returns true while the route still waits for data or for the app to
			 * follow the change it just triggered.
			 */
			const adopt = () => {
				if (Date.now() > bootUntil) {
					bootSession = void 0;
					bootPanel = null;
					return false;
				}
				const route = readRoute();
				if (bootSession !== void 0) {
					if (route.sessionId === bootSession) bootSession = void 0;
					else if (!knownSession(bootSession)) {
						if (!catalogReady()) return true;
						bootSession = void 0;
					} else if (sessionTries < BOOT_TRIES) {
						sessionTries += 1;
						try {
							workspace.openSession(bootSession);
						} catch (error) {
							console.warn('ui-router: cannot open the Session named by the URL', error);
							bootSession = void 0;
						}
						return true;
					} else bootSession = void 0;
				}
				if (bootPanel !== null) {
					if (route.panelId === bootPanel) bootPanel = null;
					else if (!layout.hasMainPanel(bootPanel)) bootPanel = null;
					else if (panelTries < BOOT_TRIES) {
						panelTries += 1;
						try {
							layout.selectPanel(bootPanel);
						} catch (error) {
							console.warn('ui-router: cannot open the panel named by the URL', error);
							bootPanel = null;
						}
						return true;
					} else bootPanel = null;
				}
				return false;
			};

			/**
			 * Publish the current route and overlay depth, or finish adopting the
			 * boot route first.
			 */
			const sync = () => {
				if (settleTarget !== null) return;
				if (backAt !== 0) {
					if (Date.now() - backAt <= BACK_MS) return;
					backAt = 0;
				}
				const overlay = overlayDepth();
				if (!live) {
					if (adopt()) return;
					live = true;
					publish({ ...readRoute(), overlay }, 'replace', 'route');
					return;
				}
				const route = { ...readRoute(), overlay };
				const fresh = Date.now() >= settleUntil;
				if (overlay > publishedOverlay) {
					// An overlay appearing is always the user's doing, so it always gets
					// its own entry, even right after a history move.
					publish(route, 'push', 'overlay');
					return;
				}
				if (overlay < publishedOverlay) {
					const tag = entryTag();
					// The current entry exists only for the overlay that just closed, so
					// stepping back removes it instead of leaving a dead entry behind.
					if (fresh && overlay === publishedOverlay - 1 && tag !== void 0 && tag.kind === 'overlay' && tag.depth === publishedOverlay) {
						backAt = Date.now();
						try {
							history.back();
							return;
						} catch (_error) {
							backAt = 0;
						}
					}
					publish(route, 'replace', 'route');
					return;
				}
				publish(route, fresh ? 'push' : 'replace', 'route');
			};

			/**
			 * Defer `sync` to the next microtask: the workspace keeps writing state
			 * after the listener returns (`replaceMain` closes the panel once the
			 * Session is selected), so reacting inside the notification would race
			 * with the very change that triggered it.
			 */
			const queue = () => {
				if (queued) return;
				queued = true;
				queueMicrotask(() => {
					queued = false;
					sync();
				});
			};

			/**
			 * Measure the overlay stack after a batch of DOM mutations.
			 */
			const scheduleScan = () => {
				if (scanTimer !== 0) return;
				scanTimer = setTimeout(() => {
					scanTimer = 0;
					sync();
				}, SCAN_DEBOUNCE_MS);
				if (typeof scanTimer === 'object' && scanTimer !== null && typeof scanTimer.unref === 'function') scanTimer.unref();
			};

			/**
			 * Close overlays until only `target` are left, then let the address bar
			 * drive the rest of the navigation. Closes commit asynchronously, so this
			 * walks one step per turn instead of closing everything at once.
			 * @param target - overlay depth the Back press asked for.
			 */
			const closeToDepth = (target) => {
				settleTarget = target;
				let tries = 0;
				const step = () => {
					if (overlayDepth() <= target || tries >= CLOSE_TRIES) {
						settleTarget = null;
						applyHash(true);
						return;
					}
					tries += 1;
					// Alternate the key and the dialog's own control, so a modal that
					// ignores Escape still closes.
					if (!closeTopOverlay(tries % 2 === 0)) {
						settleTarget = null;
						applyHash(true);
						return;
					}
					setTimeout(step, CLOSE_STEP_MS);
				};
				// Off the event path: the history handlers may run mid-commit.
				setTimeout(step, 0);
			};

			/**
			 * Bring the app to the route the address bar now names.
			 * @param forced - true when the overlay stack is already settled, so a
			 * lower depth must not start another close sequence.
			 */
			const applyHash = (forced) => {
				// A history move of our own, or the user's, has now landed.
				backAt = 0;
				if (!forced && settleTarget !== null) return;
				const target = parseHash(location.hash);
				const depth = overlayDepth();
				if (forced !== true && target.overlay < depth) {
					closeToDepth(target.overlay);
					return;
				}
				publishedOverlay = target.overlay;
				settleUntil = Date.now() + SETTLE_MS;
				// A deliberate history move supersedes whatever the page was opened with.
				bootSession = void 0;
				bootPanel = null;
				live = true;
				const route = readRoute();
				if (target.sessionId !== void 0 && target.sessionId !== route.sessionId && knownSession(target.sessionId)) {
					try {
						workspace.openSession(target.sessionId);
					} catch (error) {
						console.warn('ui-router: cannot open the Session named by the URL', error);
					}
				}
				// The panel goes last: opening a Session reveals the conversation and
				// would close a panel selected before it.
				const shown = readRoute();
				if (target.panelId !== shown.panelId) {
					if (target.panelId === null) layout.selectPanel(null);
					else if (layout.hasMainPanel(target.panelId)) layout.selectPanel(target.panelId);
				}
				// Correct the address bar when part of the target was not reachable.
				queue();
			};

			/** `popstate` / `hashchange`: the event object is not an argument here. */
			const onHistory = () => applyHash(false);

			ctx.effect(() => {
				const disposers = [panelInfo.subscribe(queue), selection.subscribe(queue), sessionList.subscribe(queue)];
				// The right column reports its own tab moves; expansion has no
				// observable, so the fallback poll below covers that half.
				const sidebar = sidebarRight();
				if (sidebar !== void 0) {
					for (const source of [sidebar.openTabs, sidebar.mounted]) {
						if (source === void 0 || typeof source.subscribe !== 'function') continue;
						try {
							disposers.push(source.subscribe(scheduleScan));
						} catch (_error) {
							/* A store already torn down by the runtime. */
						}
					}
				}
				window.addEventListener('popstate', onHistory);
				window.addEventListener('hashchange', onHistory);

				// Dialogs are portals appended to `body`, so watching its direct
				// children catches them without paying for every streamed token.
				const Observer =
					typeof window.MutationObserver === 'function'
						? window.MutationObserver
						: typeof MutationObserver === 'function'
							? MutationObserver
							: void 0;
				let observer;
				if (Observer !== void 0 && typeof document !== 'undefined' && document.body !== null && document.body !== void 0) {
					try {
						observer = new Observer(scheduleScan);
						observer.observe(document.body, { childList: true });
					} catch (_error) {
						observer = void 0;
					}
				}

				const poll = setInterval(() => {
					if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
					sync();
				}, SCAN_INTERVAL_MS);
				if (typeof poll.unref === 'function') poll.unref();

				return () => {
					window.removeEventListener('popstate', onHistory);
					window.removeEventListener('hashchange', onHistory);
					clearInterval(poll);
					if (scanTimer !== 0) {
						clearTimeout(scanTimer);
						scanTimer = 0;
					}
					if (observer !== void 0) {
						try {
							observer.disconnect();
						} catch (_error) {
							/* Already disconnected. */
						}
					}
					for (const dispose of disposers) {
						try {
							dispose();
						} catch (_error) {
							/* A store already torn down by the runtime. */
						}
					}
				};
			}, 'ui-router: history');

			queue();
		}

		exports.apply = apply;
		return module.exports;
	}
});
