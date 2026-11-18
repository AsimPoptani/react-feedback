"use client";
import { Component, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createContext as createContext$1, domToCanvas } from "modern-screenshot";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
// src/widget/context.ts
var KEY = Symbol.for("standalone.feedback.capture");
var host = typeof window === "undefined" ? {} : window;
function cleanUrl(raw) {
	try {
		const url = new URL(raw, location.href);
		return `${url.origin}${url.pathname}`;
	} catch {
		return raw.split(/[?#]/)[0] ?? "";
	}
}
function describe(value) {
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return "[unserializable]";
	}
}
function push(values, value, limit) {
	values.push(value);
	if (values.length > limit) values.shift();
}
function installCapture() {
	if (host[KEY]) return host[KEY];
	const capture = {
		console: [],
		failedFetches: []
	};
	host[KEY] = capture;
	for (const level of ["warn", "error"]) {
		const original = console[level].bind(console);
		console[level] = (...args) => {
			push(capture.console, {
				level,
				message: args.map(describe).join(" ").slice(0, 300)
			}, 30);
			original(...args);
		};
	}
	const original = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const request = input instanceof Request ? input : null;
		const info = {
			method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
			url: cleanUrl(request?.url ?? String(input))
		};
		try {
			const response = await original(input, init);
			if (!response.ok) push(capture.failedFetches, {
				...info,
				status: response.status
			}, 20);
			return response;
		} catch (error) {
			push(capture.failedFetches, {
				...info,
				error: error instanceof Error ? error.name : "Error"
			}, 20);
			throw error;
		}
	};
	return capture;
}
function getContext() {
	const capture = installCapture();
	return {
		url: location.href,
		title: document.title,
		route: location.pathname + location.search,
		viewport: {
			width: innerWidth,
			height: innerHeight
		},
		scroll: {
			x: scrollX,
			y: scrollY
		},
		devicePixelRatio,
		userAgent: navigator.userAgent,
		"prefers-color-scheme": matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
		ts: (/* @__PURE__ */ new Date()).toISOString(),
		console: [...capture.console],
		failedFetches: [...capture.failedFetches]
	};
}
// src/widget/elements.ts
var isWidget = (element) => !!element.closest("[data-feedback-root]");
function unique(selector) {
	return document.querySelectorAll(selector).length === 1;
}
function preferred(element) {
	for (const attr of [
		"data-testid",
		"id",
		"aria-label"
	]) {
		const value = element.getAttribute(attr);
		if (!value) continue;
		const selector = attr === "id" ? `#${CSS.escape(value)}` : `[${attr}="${CSS.escape(value)}"]`;
		if (unique(selector)) return selector;
	}
	return null;
}
function selectorFor(element) {
	const parts = [];
	let node = element;
	while (node) {
		const anchor = preferred(node);
		if (anchor) {
			parts.unshift(anchor);
			break;
		}
		const tag = node.tagName.toLowerCase();
		const siblings = node.parentElement ? [...node.parentElement.children].filter((el) => el.tagName === node?.tagName) : [node];
		parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
		if (unique(parts.join(" > "))) break;
		node = node.parentElement;
	}
	return parts.join(" > ");
}
function componentChain(element) {
	const key = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
	let fiber = key ? element[key] : void 0;
	const names = [];
	let depth = 0;
	while (fiber && names.length < 6 && depth++ < 100) {
		const name = fiber.type?.displayName || fiber.type?.name;
		if (name) names.push(name);
		fiber = fiber.return;
	}
	return names;
}
function rectFor(element) {
	const { x, y, width, height } = element.getBoundingClientRect();
	return {
		x,
		y,
		width,
		height
	};
}
function accessibleName(element) {
	const labelled = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
	const labels = element.labels;
	const label = labels ? [...labels].map((el) => el.textContent).join(" ") : "";
	return (labelled || element.getAttribute("aria-label") || label || element.getAttribute("alt") || element.getAttribute("title") || element.textContent || "").trim().slice(0, 200);
}
function implicitRole(element) {
	const roles = {
		BUTTON: "button",
		A: "link",
		IMG: "img",
		TEXTAREA: "textbox",
		SELECT: "combobox",
		INPUT: "textbox",
		H1: "heading",
		H2: "heading",
		H3: "heading",
		H4: "heading",
		H5: "heading",
		H6: "heading",
		NAV: "navigation",
		MAIN: "main",
		ASIDE: "complementary",
		ARTICLE: "article",
		UL: "list",
		OL: "list",
		LI: "listitem",
		TABLE: "table",
		TR: "row",
		TD: "cell",
		TH: "columnheader",
		PROGRESS: "progressbar"
	};
	if (element.matches("input[type=checkbox]")) return "checkbox";
	if (element.matches("input[type=radio]")) return "radio";
	return roles[element.tagName] ?? "";
}
function targetFor(element) {
	return {
		selector: selectorFor(element),
		tag: element.tagName.toLowerCase(),
		role: element.getAttribute("role") ?? implicitRole(element),
		name: accessibleName(element),
		text: (element.innerText ?? element.textContent ?? "").trim().slice(0, 200),
		rect: rectFor(element),
		components: componentChain(element)
	};
}
var SECTION = "section, article, main, aside, nav, header, footer, dialog, form, [role=\"region\"], [role=\"dialog\"], [role=\"main\"], [role=\"complementary\"], [role=\"navigation\"]";
function isCard(element) {
	const rect = rectFor(element);
	if (rect.width < 120 || rect.height < 60) return false;
	const style = getComputedStyle(element);
	const hasBorder = [
		"borderTopWidth",
		"borderRightWidth",
		"borderBottomWidth",
		"borderLeftWidth"
	].some((side) => parseFloat(style[side]) > 0);
	const background = style.backgroundColor;
	const hasBackground = !!background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)" && background !== getComputedStyle(element.parentElement ?? element).backgroundColor;
	return hasBorder || !!style.boxShadow && style.boxShadow !== "none" || hasBackground;
}
function sectionFor(element) {
	const semantic = element.closest(SECTION);
	if (semantic) return semantic;
	let node = element;
	while (node && node !== document.body) {
		if (isCard(node)) return node;
		node = node.parentElement;
	}
	return element;
}
// src/widget/screenshot-layout.ts
function documentClone() {
	const children = [...(document.scrollingElement ?? document.documentElement).children].filter((element) => !isWidget(element) && !element.matches("noscript")).map((element) => ({
		selector: selectorFor(element),
		transform: getComputedStyle(element).transform
	}));
	return (clone) => {
		if (!(clone instanceof HTMLElement)) return;
		for (const child of children) {
			const node = clone.querySelector(child.selector);
			if (node) node.style.transform = child.transform;
		}
	};
}
function viewportClone(scroll) {
	const scroller = document.scrollingElement ?? document.documentElement;
	const documentChildren = scroller.scrollTop || scroller.scrollLeft ? [...scroller.children].map((element) => ({
		selector: selectorFor(element),
		transform: getComputedStyle(element).transform
	})) : [];
	const positioned = [];
	for (const element of document.querySelectorAll("*")) {
		if (isWidget(element)) continue;
		const position = getComputedStyle(element).position;
		if (position === "fixed" || position === "sticky") positioned.push(positionedSnapshot(element, position === "sticky"));
	}
	return (clone) => {
		if (!(clone instanceof HTMLElement)) return;
		for (const child of documentChildren) {
			const node = clone.querySelector(child.selector);
			if (node) node.style.transform = child.transform;
		}
		for (const item of positioned.toReversed()) liftPositioned(clone, item, scroll);
	};
}
function liftPositioned(clone, item, scroll) {
	const node = clone.querySelector(item.selector);
	if (!node) return;
	const floating = item.sticky ? node.cloneNode(true) : node;
	if (item.sticky) node.style.visibility = "hidden";
	Object.assign(floating.style, {
		position: "absolute",
		left: `${item.rect.x + scroll.x}px`,
		top: `${item.rect.y + scroll.y}px`,
		width: `${item.rect.width}px`,
		height: `${item.rect.height}px`,
		right: "auto",
		bottom: "auto",
		margin: "0",
		transform: "none",
		boxSizing: "border-box",
		maxWidth: "none",
		maxHeight: "none"
	});
	if (item.clip) floating.style.clipPath = item.clip;
	clone.append(floating);
}
function positionedSnapshot(element, sticky) {
	const rect = rectFor(element);
	return {
		selector: selectorFor(element),
		rect,
		sticky,
		clip: ancestorClip(element, rect, sticky)
	};
}
function ancestorClip(element, rect, sticky) {
	const ancestors = [];
	for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
	const containingBlock = ancestors.some((parent) => getComputedStyle(parent).transform !== "none" && !!getComputedStyle(parent).transform);
	if (!sticky && !containingBlock) return null;
	let left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
	for (const parent of ancestors) {
		const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
		if (/auto|scroll|hidden|clip/.test(style.overflowX || style.overflow)) {
			left = Math.max(left, bounds.left);
			right = Math.min(right, bounds.right);
		}
		if (/auto|scroll|hidden|clip/.test(style.overflowY || style.overflow)) {
			top = Math.max(top, bounds.top);
			bottom = Math.min(bottom, bounds.bottom);
		}
	}
	return `inset(${Math.max(0, top - rect.y)}px ${Math.max(0, rect.x + rect.width - right)}px ${Math.max(0, rect.y + rect.height - bottom)}px ${Math.max(0, left - rect.x)}px)`;
}
// src/widget/screenshot.ts
var filter = (node) => !(node instanceof Element) || !node.closest("noscript") && !isWidget(node);
var cache = {
	requests: /* @__PURE__ */ new Map(),
	fonts: /* @__PURE__ */ new Map()
};
var CACHE_LIMIT = 400;
async function render$1(options) {
	if (cache.requests.size > CACHE_LIMIT) cache.requests.clear();
	const context = await createContext$1(document.documentElement, options);
	context.requests = cache.requests;
	context.fontCssTexts = cache.fonts;
	try {
		return await domToCanvas(context);
	} finally {
		context.sandbox?.remove();
	}
}
function canvasFor(width, height) {
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(width));
	canvas.height = Math.max(1, Math.round(height));
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("This browser could not create a drawing canvas.");
	return {
		canvas,
		ctx
	};
}
async function loadImage(url) {
	const image = new Image();
	image.src = url;
	await image.decode();
	return image;
}
function cropRect(rect, width, height) {
	const x = Math.max(0, Math.min(width, rect.x - 12));
	const y = Math.max(0, Math.min(height, rect.y - 12));
	const right = Math.max(x, Math.min(width, rect.x + rect.width + 12));
	const bottom = Math.max(y, Math.min(height, rect.y + rect.height + 12));
	return {
		x,
		y,
		width: right - x,
		height: bottom - y
	};
}
async function captureViewport(rect) {
	const x = scrollX, y = scrollY, width = innerWidth, height = innerHeight, scale = devicePixelRatio || 1;
	const source = await render$1({
		width,
		height,
		scale,
		filter,
		style: {
			transform: `translate(${-x}px, ${-y}px)`,
			overflow: "visible"
		},
		features: { restoreScrollPosition: true },
		fetch: { requestInit: { credentials: "same-origin" } },
		onCloneNode: viewportClone({
			x,
			y
		})
	});
	const area = cropRect(rect, width, height);
	if (!area.width || !area.height) throw new Error("The capture is outside the viewport.");
	const { canvas, ctx } = canvasFor(area.width * scale, area.height * scale);
	ctx.drawImage(source, area.x * scale, area.y * scale, area.width * scale, area.height * scale, 0, 0, canvas.width, canvas.height);
	const shot = {
		url: canvas.toDataURL("image/png"),
		width: canvas.width,
		height: canvas.height,
		origin: {
			x: x + area.x,
			y: y + area.y
		}
	};
	const context = canvasFor(width * scale, height * scale);
	context.ctx.drawImage(source, 0, 0);
	context.ctx.strokeStyle = "#b02f62";
	context.ctx.lineWidth = 3 * scale;
	context.ctx.strokeRect(rect.x * scale, rect.y * scale, rect.width * scale, rect.height * scale);
	return {
		shot,
		contextImage: context.canvas.toDataURL("image/png")
	};
}
function pageSize() {
	const html = document.documentElement, body = document.body;
	return {
		width: Math.max(innerWidth, html.scrollWidth, body.scrollWidth),
		height: Math.max(innerHeight, html.scrollHeight, body.scrollHeight)
	};
}
async function capturePage(size) {
	const height = Math.min(size.height, 16e3), scale = devicePixelRatio || 1;
	const source = await render$1({
		width: size.width,
		height,
		scale,
		filter,
		style: {
			transform: "none",
			overflow: "visible",
			height: `${height}px`
		},
		features: { restoreScrollPosition: true },
		fetch: { requestInit: { credentials: "same-origin" } },
		onCloneNode: documentClone()
	});
	return {
		shot: {
			url: source.toDataURL("image/png"),
			width: source.width,
			height: source.height,
			origin: {
				x: 0,
				y: 0
			}
		},
		clipped: size.height > height ? `Full page capture clipped at 16 000 px (page height: ${size.height} px).` : void 0
	};
}
// src/widget/layer.ts
function useFeedbackLayer(root) {
	useLayoutEffect(() => {
		const node = root.current;
		const home = node?.parentElement;
		if (!node || !home) return;
		const update = () => {
			const target = [...document.querySelectorAll("dialog[open]")].at(-1) ?? home;
			if (node.parentElement !== target) target.append(node);
		};
		const observer = new MutationObserver(update);
		observer.observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["open"]
		});
		update();
		return () => {
			observer.disconnect();
			if (node.parentElement !== home) home.append(node);
		};
	}, [root]);
}
// src/widget/shortcuts.ts
function modifiers() {
	const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
	return {
		command: mac ? "⌘" : "Ctrl",
		alt: mac ? "⌥" : "Alt",
		shift: mac ? "⇧" : "Shift",
		commandKey: mac ? "Meta" : "Control"
	};
}
function keyLabel(...keys) {
	const { alt, command, shift } = modifiers();
	const names = {
		Alt: alt,
		Command: command,
		Shift: shift
	};
	return keys.map((key) => names[key] ?? key).join(command === "⌘" ? "" : "+");
}
function isInput(target) {
	return target instanceof Element && !!target.closest("input, textarea, select, [contenteditable]:not([contenteditable=\"false\"])");
}
var choices = {
	KeyR: "region",
	KeyE: "element",
	KeyS: "section",
	KeyP: "page",
	KeyL: "list"
};
var digits = {
	Digit1: "region",
	Digit2: "element",
	Digit3: "section",
	Digit4: "page"
};
function noteAction(event) {
	if (event.code === "Escape") return "back";
	if (event.code === "Enter" && (event.metaKey || event.ctrlKey)) return "save";
	if (event.code === "KeyD" && event.altKey) return "draw";
}
function toolbarAction(event) {
	if (event.altKey || event.metaKey || event.ctrlKey) return;
	if (event.code === "Slash" && event.shiftKey) return "help";
	return choices[event.code] ?? digits[event.code];
}
function isWidgetEvent(event) {
	return event.target instanceof Element && !!event.target.closest("[data-feedback-root]");
}
function keyboardTarget(event) {
	return event.target instanceof Element ? event.target : document.activeElement;
}
function nativeButtonActivation(event) {
	return ["Enter", "Space"].includes(event.code) && !!keyboardTarget(event)?.closest("[data-feedback-root] button");
}
function action(event, step) {
	if (step === "editor") return;
	if (event.code === "Escape" && step !== "closed") return "back";
	const target = keyboardTarget(event);
	if (isInput(target) && !target?.closest("[data-feedback-root]")) return;
	if (step === "note") return noteAction(event);
	if (isInput(target)) return;
	if (event.altKey && event.shiftKey) return event.code === "KeyF" ? "toggle" : choices[event.code];
	if (step === "toolbar") return toolbarAction(event);
}
function useShortcuts(step, run) {
	useEffect(() => {
		const keyboard = (event) => {
			const command = action(event, step);
			if (!command) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			run(command);
		};
		window.addEventListener("keydown", keyboard, true);
		return () => window.removeEventListener("keydown", keyboard, true);
	}, [step, run]);
}
// src/widget/focus.ts
var TABBABLE = "button:not(:disabled):not([tabindex=\"-1\"]), input:not(:disabled), textarea:not(:disabled), [tabindex=\"0\"]";
function tabbables(root) {
	return [...root?.querySelectorAll(TABBABLE) ?? []];
}
function focusInto(element) {
	element?.focus({ preventScroll: true });
}
/** Focus sits on the page itself (an app control), not on the body and not in the widget. */
function onAppControl(element = document.activeElement) {
	return !!element && element.isConnected && element !== document.body && element !== document.documentElement && !element.closest("[data-feedback-root]");
}
/** Return focus to the element focused before the widget opened, else to the fallback. */
function restoreFocus(target, fallback) {
	if (target?.isConnected) {
		focusInto(target);
		if (document.activeElement === target) return;
	}
	focusInto(fallback);
}
/** Where Tab should wrap to, or undefined to let the browser move focus normally. */
function wrapTarget(elements, back) {
	const index = elements.indexOf(document.activeElement), last = elements.length - 1;
	if (back) return index <= 0 ? elements[last] : void 0;
	return index < 0 || index === last ? elements[0] : void 0;
}
/** Locks page scroll and keeps Tab inside `root`. Initial focus is the caller's job. */
function useModalFocus(root) {
	useEffect(() => {
		const overflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const trap = (event) => {
			if (event.code !== "Tab") return;
			const next = wrapTarget(tabbables(root.current), event.shiftKey);
			if (next) {
				event.preventDefault();
				focusInto(next);
			}
		};
		const node = root.current;
		node?.addEventListener("keydown", trap);
		return () => {
			document.body.style.overflow = overflow;
			node?.removeEventListener("keydown", trap);
		};
	}, [root]);
}
// src/widget/usePicker.ts
function usePicker(mode, active, onPick, onLock) {
	const [hover, setHover] = useState(null);
	const [focusKey, setFocusKey] = useState(0);
	const selected = useRef(null), leaf = useRef(null);
	const lockRef = useRef(onLock);
	lockRef.current = onLock;
	const locked = useRef(false), children = useRef([]);
	const clear = useCallback(() => {
		selected.current = null;
		leaf.current = null;
		locked.current = false;
		children.current = [];
		setHover(null);
	}, []);
	const show = useCallback((element) => {
		selected.current = element;
		setHover(element ? {
			rect: rectFor(element),
			label: [
				element.tagName.toLowerCase(),
				selectorFor(element),
				...componentChain(element)
			].filter(Boolean).join(" · "),
			locked: locked.current
		} : null);
	}, []);
	const confirm = useCallback(() => {
		if (selected.current) {
			locked.current = true;
			show(selected.current);
			onPick(targetFor(selected.current));
		}
	}, [onPick, show]);
	useEffect(() => {
		if (!mode || !active) return;
		function target(event) {
			const element = event.target instanceof Element ? event.target : null;
			return element && !isWidget(element) ? element : null;
		}
		function highlight(event) {
			if (locked.current) return;
			const element = target(event);
			if (!element || element === leaf.current) return;
			leaf.current = element;
			children.current = [];
			show(mode === "section" ? sectionFor(element) : element);
		}
		function suppress(event) {
			if (target(event)) {
				event.preventDefault();
				event.stopImmediatePropagation();
			}
		}
		function select(event) {
			const element = target(event);
			if (!element) return;
			suppress(event);
			const same = selected.current && leaf.current === element;
			const chosen = same ? selected.current : mode === "section" ? sectionFor(element) : element;
			if (!same) children.current = [];
			leaf.current = element;
			locked.current = true;
			show(chosen);
			setFocusKey((count) => count + 1);
			lockRef.current?.(targetFor(chosen));
		}
		function navigate(code) {
			const element = selected.current;
			if (!element) return;
			if (code === "ArrowUp" && element.parentElement) {
				children.current.push(element);
				show(element.parentElement);
			}
			if (code === "ArrowDown" && children.current.length) show(children.current.pop());
			if (locked.current && selected.current && selected.current !== element) lockRef.current?.(targetFor(selected.current));
		}
		function keyboard(event) {
			if (skipKey(event, !!selected.current)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (event.type !== "keydown") return;
			activate(event);
		}
		function activate(event) {
			if (event.code === "Tab") {
				focusInto(document.querySelector("[data-feedback-root] .fb-selection-toolbar button") ?? document.querySelector("[data-feedback-root] .fb-pick-hint button"));
				return;
			}
			if (!selected.current) highlight(event);
			if (event.code === "Enter") confirm();
			else navigate(event.code);
		}
		const events = [
			["pointermove", highlight],
			["focusin", highlight],
			["pointerdown", suppress],
			["pointerup", suppress],
			["click", select],
			["dblclick", suppress],
			["contextmenu", suppress],
			["keydown", keyboard],
			["keyup", keyboard]
		];
		for (const [name, handler] of events) window.addEventListener(name, handler, true);
		const focused = document.activeElement;
		if (!selected.current && focused && onAppControl(focused)) {
			leaf.current = focused;
			show(mode === "section" ? sectionFor(focused) : focused);
		}
		const update = () => show(selected.current);
		window.addEventListener("scroll", update, true);
		window.addEventListener("resize", update);
		return () => {
			for (const [name, handler] of events) window.removeEventListener(name, handler, true);
			window.removeEventListener("scroll", update, true);
			window.removeEventListener("resize", update);
		};
	}, [
		mode,
		active,
		confirm,
		show
	]);
	return {
		hover: active ? hover : null,
		clear,
		confirm,
		focusKey,
		hasSelection: !!hover?.locked
	};
}
function skipKey(event, hasTarget) {
	if (event.type !== "keydown") return isWidgetEvent(event);
	if (event.code === "Escape") return true;
	if (event.altKey && event.shiftKey && [
		"KeyF",
		"KeyR",
		"KeyE",
		"KeyS",
		"KeyP",
		"KeyL"
	].includes(event.code)) return true;
	if (!isWidgetEvent(event)) return false;
	return !hasTarget || ![
		"Enter",
		"ArrowUp",
		"ArrowDown"
	].includes(event.code) || nativeButtonActivation(event);
}
function useCaptureShield(enabled) {
	useEffect(() => {
		if (!enabled) return;
		const block = (event) => {
			if (isWidgetEvent(event)) return;
			if (event instanceof KeyboardEvent && skipKey(event, false)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
		};
		const events = [
			"pointerdown",
			"pointerup",
			"click",
			"dblclick",
			"contextmenu",
			"keydown",
			"keyup"
		];
		for (const name of events) window.addEventListener(name, block, true);
		return () => {
			for (const name of events) window.removeEventListener(name, block, true);
		};
	}, [enabled]);
}
// src/widget/Keycap.tsx
function Keycap({ children }) {
	return /* @__PURE__ */ jsx("kbd", {
		"aria-hidden": "true",
		tabIndex: -1,
		children
	});
}
// src/widget/draft.ts
var BLANK = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
var CAPTURE_FAILED = "Screenshot capture failed, so this note has no picture.";
function feedbackBody(draft, result, note, annotated, live) {
	const extra = [result?.clipped, result ? void 0 : CAPTURE_FAILED].filter(Boolean).join("\n\n");
	return {
		note: extra ? `${note}\n\n${extra}` : note,
		mode: draft.mode,
		target: draft.target,
		image: result?.shot.url ?? BLANK,
		...annotated ? { annotated } : {},
		...result?.contextImage ? { context_image: result.contextImage } : {},
		context: {
			...draft.context,
			console: live.console,
			failedFetches: live.failedFetches
		}
	};
}
// src/widget/FeedbackDraft.tsx
function beside(rect, width, height) {
	if (!rect || innerWidth <= 600) return {};
	const top = Math.max(12, Math.min(rect.y, innerHeight - height - 12));
	if (rect.x + rect.width + width + 24 <= innerWidth) return {
		left: rect.x + rect.width + 12,
		top,
		bottom: "auto"
	};
	if (rect.x - width - 12 >= 12) return {
		left: rect.x - width - 12,
		top,
		bottom: "auto"
	};
	if (rect.y >= height + 24) return {
		left: Math.max(12, Math.min(rect.x, innerWidth - width - 12)),
		top: rect.y - height - 12,
		bottom: "auto"
	};
	return {};
}
function FeedbackDraft(props) {
	const id = useId();
	const root = useRef(null);
	const textarea = useRef(null);
	const [position, setPosition] = useState({});
	useModalFocus(root);
	useEffect(() => {
		focusInto(textarea.current);
	}, []);
	useLayoutEffect(() => {
		const update = () => {
			if (root.current) setPosition(beside(props.rect, root.current.offsetWidth, root.current.offsetHeight));
		};
		update();
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, [props.rect]);
	return /* @__PURE__ */ jsxs("section", {
		ref: root,
		className: "fb-panel fb-note",
		"aria-label": "Feedback note",
		style: position,
		children: [
			props.shot ? /* @__PURE__ */ jsx("img", {
				className: "fb-preview",
				src: props.annotated ?? props.shot.url,
				alt: "Captured area"
			}) : /* @__PURE__ */ jsx("p", {
				className: "fb-preview-pending",
				role: "status",
				children: props.failed ? CAPTURE_FAILED : "Capturing…"
			}),
			/* @__PURE__ */ jsx("label", {
				htmlFor: id,
				children: "Note"
			}),
			/* @__PURE__ */ jsx("textarea", {
				ref: textarea,
				id,
				maxLength: 1e4 - (props.clipped ? props.clipped.length + 2 : 0),
				value: props.note,
				onChange: (event) => props.onNote(event.target.value),
				placeholder: "What should change?"
			}),
			props.clipped && /* @__PURE__ */ jsxs("p", {
				className: "fb-hint",
				children: [props.clipped, " This will be included in your note."]
			}),
			/* @__PURE__ */ jsxs("div", {
				className: "fb-toolbar",
				children: [
					/* @__PURE__ */ jsxs("button", {
						type: "button",
						onClick: props.onEdit,
						disabled: !props.shot,
						"aria-label": "Draw on it",
						"aria-keyshortcuts": "Alt+D",
						children: ["Draw on it ", /* @__PURE__ */ jsx(Keycap, { children: keyLabel("Alt", "D") })]
					}),
					/* @__PURE__ */ jsxs("button", {
						type: "button",
						onClick: props.onCancel,
						"aria-keyshortcuts": "Escape",
						children: ["Cancel ", /* @__PURE__ */ jsx(Keycap, { children: "Esc" })]
					}),
					/* @__PURE__ */ jsxs("button", {
						className: "fb-save",
						type: "button",
						disabled: !props.note.trim(),
						onClick: props.onSave,
						"aria-label": "Save",
						"aria-keyshortcuts": `${modifiers().commandKey}+Enter`,
						children: ["Save ", /* @__PURE__ */ jsx(Keycap, { children: keyLabel("Command", "↵") })]
					})
				]
			})
		]
	});
}
var BACKOFF = [
	2e3,
	5e3,
	15e3,
	3e4,
	6e4
];
var SEND_TIMEOUT = 9e4;
var EMPTY = {
	items: [],
	pending: 0,
	failed: 0,
	persistent: true
};
var RETRY_STATUS = /* @__PURE__ */ new Set([408, 429]);
function tooLarge(status) {
	return status === 413;
}
async function refusal(response) {
	if (tooLarge(response.status)) return "Too large for the feedback server. Discard it and capture a smaller area.";
	const detail = await response.json().then((data) => typeof data.detail === "string" ? data.detail : "", () => "");
	return `The feedback server refused it (${response.status}${detail ? `: ${detail}` : ""}).`;
}
var Outbox$1 = class {
	endpoint;
	store;
	entries = [];
	listeners = /* @__PURE__ */ new Set();
	sentListeners = /* @__PURE__ */ new Set();
	snapshot = EMPTY;
	persistent = true;
	loading = null;
	loaded = false;
	active = false;
	running = false;
	timer;
	last = 0;
	constructor(endpoint, store) {
		this.endpoint = endpoint;
		this.store = store;
	}
	subscribe = (listener) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	onSent = (listener) => {
		this.sentListeners.add(listener);
		return () => {
			this.sentListeners.delete(listener);
		};
	};
	getSnapshot = () => this.snapshot;
	/** Resend what is left from before, and flush again when the network or the tab comes back. */
	start() {
		this.active = true;
		window.addEventListener("online", this.flush);
		window.addEventListener("focus", this.flush);
		this.loading ??= this.load();
		this.loading.then(() => this.pump());
	}
	stop() {
		this.active = false;
		clearTimeout(this.timer);
		window.removeEventListener("online", this.flush);
		window.removeEventListener("focus", this.flush);
	}
	enqueue(job) {
		const fallback = job.build(null), ready = !(job.capture instanceof Promise);
		const entry = {
			id: job.id,
			seq: this.next(),
			label: job.label,
			text: job.text,
			state: "queued",
			fallback,
			body: ready ? job.build(job.capture) : null,
			sending: false,
			attempts: 0,
			nextAt: 0
		};
		this.entries.push(entry);
		this.save(entry);
		if (!ready) {
			const settle = (body) => {
				entry.pending = void 0;
				entry.body = body;
				this.save(entry);
				this.emit();
				this.pump();
			};
			entry.pending = job.capture.then((shot) => settle(job.build(shot)), () => settle(fallback));
		}
		this.emit();
		this.pump();
	}
	/** Skip the backoff wait: the network or the tab just came back. */
	flush = () => {
		for (const entry of this.entries) entry.nextAt = 0;
		this.pump();
	};
	retry(id) {
		const entry = this.entries.find((item) => item.id === id && item.state === "failed");
		if (!entry) return;
		entry.state = "queued";
		entry.reason = void 0;
		entry.attempts = 0;
		entry.nextAt = 0;
		this.save(entry);
		this.emit();
		this.pump();
	}
	/** A stuck item (picture too big, slow uplink): send its text alone, with the no-picture note. */
	sendWithoutPicture(id) {
		const entry = this.entries.find((item) => item.id === id && !item.sending && !item.pending);
		if (!entry) return;
		entry.body = entry.fallback;
		entry.state = "queued";
		entry.reason = void 0;
		entry.attempts = 0;
		entry.nextAt = 0;
		this.save(entry);
		this.emit();
		this.pump();
	}
	discard(id) {
		const entry = this.entries.find((item) => item.id === id);
		if (!entry) return;
		this.entries = this.entries.filter((item) => item !== entry);
		this.store.remove(id).catch(() => {});
		this.emit();
	}
	next() {
		this.last = Math.max(Date.now(), this.last + 1);
		return this.last;
	}
	save(entry) {
		if (!this.entries.includes(entry)) return;
		const { id, seq, label, text, body, fallback, state, reason } = entry;
		this.store.put({
			id,
			seq,
			label,
			text,
			body,
			fallback,
			state,
			...reason ? { reason } : {}
		}).catch(() => {});
	}
	async load() {
		this.persistent = await this.store.ready;
		const records = await this.store.load().catch(() => []);
		const known = new Set(this.entries.map((entry) => entry.id));
		for (const record of records) if (!known.has(record.id)) this.entries.push({
			...record,
			body: record.body ?? record.fallback,
			sending: false,
			attempts: 0,
			nextAt: 0
		});
		this.entries.sort((a, b) => a.seq - b.seq);
		this.loaded = true;
		this.emit();
	}
	emit() {
		const items = this.entries.map((entry) => ({
			id: entry.id,
			label: entry.label,
			text: entry.text,
			reason: entry.reason,
			attempts: entry.attempts,
			stuck: entry.state !== "failed" && entry.attempts >= 3,
			status: statusOf(entry)
		}));
		const failed = items.filter((item) => item.status === "failed").length;
		this.snapshot = {
			items,
			failed,
			pending: items.length - failed,
			persistent: this.persistent
		};
		for (const listener of this.listeners) listener();
	}
	async pump() {
		if (this.running || !this.active || !this.loaded) return;
		this.running = true;
		try {
			while (this.active) {
				const entry = this.nextDue();
				if (!entry) return;
				await this.send(entry);
			}
		} finally {
			this.running = false;
		}
	}
	/** The first item to send now. A waiting item holds the ones behind it (to keep order) until it is stuck. */
	nextDue() {
		let soonest = Infinity;
		for (const entry of this.entries) {
			if (entry.state === "failed") continue;
			if (entry.pending) return null;
			if (entry.nextAt - Date.now() <= 0) return entry;
			soonest = Math.min(soonest, entry.nextAt);
			if (entry.attempts < 3) break;
		}
		if (soonest < Infinity) {
			clearTimeout(this.timer);
			this.timer = setTimeout(() => {
				this.pump();
			}, Math.max(0, soonest - Date.now()));
		}
		return null;
	}
	async send(entry) {
		entry.sending = true;
		this.emit();
		const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT);
		try {
			const response = await fetch(`${this.endpoint}/api/items`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				signal: controller.signal,
				body: JSON.stringify({
					...entry.body ?? entry.fallback,
					client_id: entry.id
				})
			});
			if (response.ok) {
				this.done(entry);
				return;
			}
			if (response.status < 500 && !RETRY_STATUS.has(response.status)) {
				await this.fail(entry, response);
				return;
			}
			this.wait(entry);
		} catch {
			this.wait(entry);
		} finally {
			clearTimeout(timeout);
			entry.sending = false;
			this.emit();
		}
	}
	done(entry) {
		this.entries = this.entries.filter((item) => item !== entry);
		this.store.remove(entry.id).catch(() => {});
		for (const listener of this.sentListeners) listener();
	}
	async fail(entry, response) {
		entry.state = "failed";
		entry.reason = await refusal(response);
		this.save(entry);
	}
	wait(entry) {
		entry.nextAt = Date.now() + BACKOFF[Math.min(entry.attempts, BACKOFF.length - 1)];
		entry.attempts++;
		if (entry.attempts === 3) {
			this.entries = this.entries.filter((item) => item !== entry);
			this.entries.push(entry);
		}
	}
};
function statusOf(entry) {
	if (entry.state === "failed") return "failed";
	if (entry.sending) return "sending";
	if (entry.pending) return "capturing";
	return entry.attempts > 0 ? "retrying" : "queued";
}
function newId() {
	return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
// src/widget/useOutbox.tsx
var OutboxContext = createContext(null);
var none = () => () => {};
function useOutbox() {
	return useContext(OutboxContext);
}
function useOutboxSnapshot() {
	const outbox = useOutbox();
	return useSyncExternalStore(outbox?.subscribe ?? none, outbox?.getSnapshot ?? (() => EMPTY));
}
// src/widget/OutboxList.tsx
var WORDS = {
	capturing: "Waiting for its picture",
	queued: "Waiting to send",
	sending: "Sending…",
	retrying: "Could not reach the feedback server. Waiting to retry",
	failed: "Failed"
};
/** Notes saved but not yet delivered. Sent notes leave here and appear in the list. */
function Outbox({ onSent }) {
	const outbox = useOutbox(), { items, persistent } = useOutboxSnapshot();
	useEffect(() => onSent && outbox ? outbox.onSent(onSent) : void 0, [outbox, onSent]);
	if (!outbox || !items.length) return null;
	return /* @__PURE__ */ jsxs("section", {
		className: "fb-outbox",
		"aria-label": "Outbox",
		children: [
			/* @__PURE__ */ jsx("h3", { children: "Outbox" }),
			!persistent && /* @__PURE__ */ jsx("p", {
				className: "fb-hint",
				children: "This browser can't keep unsent notes across a reload, so they are held in memory only."
			}),
			/* @__PURE__ */ jsx("ul", { children: items.map((item) => /* @__PURE__ */ jsxs("li", {
				"data-status": item.stuck ? "stuck" : item.status,
				children: [
					/* @__PURE__ */ jsx("strong", { children: item.label }),
					/* @__PURE__ */ jsx("span", { children: item.status === "failed" && item.reason ? `${WORDS.failed}: ${item.reason}` : item.stuck ? `Still can't send it after ${item.attempts} tries. The other notes are going ahead of it` : WORDS[item.status] }),
					(item.status === "failed" || item.stuck) && /* @__PURE__ */ jsx("pre", {
						className: "fb-outbox-note",
						"data-testid": "outbox-note",
						children: item.text
					}),
					(item.status === "failed" || item.stuck) && /* @__PURE__ */ jsxs("span", {
						className: "fb-outbox-actions",
						children: [item.status === "failed" ? /* @__PURE__ */ jsx("button", {
							type: "button",
							onClick: () => outbox.retry(item.id),
							children: "Retry"
						}) : /* @__PURE__ */ jsx("button", {
							type: "button",
							onClick: () => outbox.sendWithoutPicture(item.id),
							children: "Send without picture"
						}), /* @__PURE__ */ jsx("button", {
							type: "button",
							onClick: () => outbox.discard(item.id),
							children: "Discard"
						})]
					})
				]
			}, item.id)) })
		]
	});
}
// src/widget/FeedbackList.tsx
function FeedbackList({ endpoint, onClose }) {
	const [items, setItems] = useState([]);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		if (revision > 0) setItems([]);
		const controller = new AbortController();
		setLoading(true);
		setError("");
		fetch(`${endpoint}/api/items`, { signal: controller.signal }).then(async (response) => {
			if (!response.ok) throw new Error("Could not load feedback.");
			const data = await response.json();
			if (!controller.signal.aborted) setItems(data.sort((a, b) => b.created_at.localeCompare(a.created_at)));
		}).catch(() => {
			if (!controller.signal.aborted) setError("Could not load feedback. Check the feedback server and try Refresh.");
		}).finally(() => {
			if (!controller.signal.aborted) setLoading(false);
		});
		return () => controller.abort();
	}, [endpoint, revision]);
	return /* @__PURE__ */ jsxs("section", {
		className: "fb-panel",
		"aria-label": "My feedback",
		children: [
			/* @__PURE__ */ jsxs("header", { children: [/* @__PURE__ */ jsx("h2", { children: "My feedback" }), /* @__PURE__ */ jsxs("button", {
				type: "button",
				onClick: onClose,
				"aria-keyshortcuts": "Escape",
				children: ["Close ", /* @__PURE__ */ jsx(Keycap, { children: "Esc" })]
			})] }),
			/* @__PURE__ */ jsx(Outbox, { onSent: () => setRevision((previous) => previous + 1) }),
			/* @__PURE__ */ jsx("a", {
				href: `${endpoint}/inbox/`,
				target: "_blank",
				rel: "noopener noreferrer",
				children: "Open inbox"
			}),
			" ",
			/* @__PURE__ */ jsx("button", {
				type: "button",
				onClick: () => setRevision((previous) => previous + 1),
				children: "Refresh"
			}),
			loading && /* @__PURE__ */ jsx("p", {
				role: "status",
				children: "Loading…"
			}),
			error && /* @__PURE__ */ jsx("p", {
				role: "alert",
				children: error
			}),
			!loading && !items.length && !error && /* @__PURE__ */ jsx("p", { children: "No feedback yet." }),
			items.map((item) => /* @__PURE__ */ jsxs("details", {
				className: "fb-item",
				children: [/* @__PURE__ */ jsxs("summary", { children: [
					/* @__PURE__ */ jsx("strong", { children: item.id }),
					" · ",
					/* @__PURE__ */ jsx("a", {
						href: `${endpoint}/inbox/#/${item.id}`,
						target: "_blank",
						rel: "noopener noreferrer",
						children: "Open thread"
					}),
					/* @__PURE__ */ jsx("br", {}),
					/* @__PURE__ */ jsx("time", {
						dateTime: item.created_at,
						children: new Date(item.created_at).toLocaleString()
					}),
					" · ",
					item.mode,
					" · ",
					/* @__PURE__ */ jsx("span", { children: item.status }),
					/* @__PURE__ */ jsx("p", { children: item.note_first_line }),
					item.reply && /* @__PURE__ */ jsxs("p", { children: ["Reply: ", item.reply.split("\n")[0]] })
				] }), item.reply ? /* @__PURE__ */ jsx("div", {
					className: "fb-reply",
					children: item.reply
				}) : /* @__PURE__ */ jsx("p", { children: "No reply yet." })]
			}, item.id))
		]
	});
}
// src/widget/StepHints.tsx
function hintsFor(step, locked) {
	const { alt } = modifiers();
	const cancel = {
		key: "Esc",
		word: "cancel"
	};
	if (step === "region" && !locked) return [{
		word: "Drag to select",
		touch: "Drag to select"
	}, cancel];
	if (step === "region") return [
		{
			key: "↵",
			word: "write note",
			touch: "Tap Write note"
		},
		{
			key: "arrows",
			word: "move"
		},
		{
			key: `${modifiers().shift} arrows`,
			word: "×10"
		},
		{
			key: `${alt} arrows`,
			word: "resize"
		},
		{
			word: "drag to redraw",
			touch: "Drag to redraw"
		},
		cancel
	];
	if (step === "element" || step === "section") return [
		...locked ? [{
			key: "↵",
			word: "write note",
			touch: "Tap Write note"
		}] : [{
			word: "Click to select",
			touch: "Tap to select"
		}],
		{
			key: "↑",
			word: "parent"
		},
		{
			key: "↓",
			word: "child"
		},
		...locked ? [{
			word: "click another to change",
			touch: "Tap another to change"
		}] : [{
			key: "↵",
			word: "select and write"
		}],
		cancel
	];
	if (step === "editor") return [
		...[
			"P:Pen",
			"B:Box",
			"A:Arrow",
			"T:Text",
			"1/2/3:colour"
		].map((item) => {
			const [key, word] = item.split(":");
			return {
				key,
				word
			};
		}),
		{
			key: keyLabel("Command", "Z"),
			word: "undo"
		},
		{
			key: "Del",
			word: "clear"
		},
		{
			key: "↵",
			word: "done"
		},
		cancel,
		{
			word: "Draw on the image",
			touch: "Draw on the image · tap tools, Done or Cancel",
			touchOnly: true
		}
	];
	return [];
}
function StepHints({ step, locked = false }) {
	const [coarse, setCoarse] = useState(() => window.matchMedia("(pointer: coarse)").matches);
	const root = useRef(null);
	const hints = hintsFor(step, locked).filter((hint) => coarse ? hint.touch : !hint.touchOnly);
	useEffect(() => {
		const media = window.matchMedia("(pointer: coarse)");
		const update = () => setCoarse(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		const element = root.current;
		if (!element) return;
		const owner = element.closest(".fb-root");
		const update = () => owner?.style.setProperty("--fb-hint-height", `${element.getBoundingClientRect().height}px`);
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => {
			observer.disconnect();
			owner?.style.removeProperty("--fb-hint-height");
		};
	}, []);
	if (!hints.length) return null;
	return /* @__PURE__ */ jsx("div", {
		ref: root,
		className: `fb-step-hints fb-step-${step}`,
		role: "note",
		"aria-label": "Step shortcuts",
		children: hints.map((hint) => /* @__PURE__ */ jsxs("span", {
			className: "fb-hint-item",
			children: [
				!coarse && hint.key && /* @__PURE__ */ jsx(Keycap, { children: hint.key }),
				" ",
				coarse ? hint.touch : hint.word
			]
		}, hint.word))
	});
}
var TIP_KEY = "react-feedback.shortcuts-tip";
function FirstRunTip() {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		try {
			if (!localStorage.getItem(TIP_KEY)) {
				setVisible(true);
				localStorage.setItem(TIP_KEY, "1");
			}
		} catch {
			setVisible(true);
		}
		const dismiss = () => setVisible(false);
		const events = ["click", "keydown"];
		for (const event of events) window.addEventListener(event, dismiss, true);
		return () => {
			for (const event of events) window.removeEventListener(event, dismiss, true);
		};
	}, []);
	return visible ? /* @__PURE__ */ jsx("p", {
		className: "fb-first-tip",
		children: "Tip: press ? any time to see every shortcut"
	}) : null;
}
// src/widget/MarkupEditor.tsx
var toolKeys = {
	KeyP: "pen",
	KeyB: "box",
	KeyA: "arrow",
	KeyT: "text"
};
var COLORS = [
	"#e52e58",
	"#00796f",
	"#ffce38"
];
function markupAction(event) {
	if (event.code === "Escape") return "cancel";
	if (nativeButtonActivation(event)) return;
	if (isInput(keyboardTarget(event))) return;
	if (event.code === "Enter") return "export";
	if (event.code === "Delete") return "clear";
	if (event.code === "KeyZ" && (event.metaKey || event.ctrlKey)) return "undo";
	if (event.altKey || event.ctrlKey || event.metaKey) return;
	if (toolKeys[event.code]) return event.code;
	const index = [
		"Digit1",
		"Digit2",
		"Digit3"
	].indexOf(event.code);
	if (index >= 0) return String(index);
}
function drawMark(ctx, mark) {
	const start = mark.points[0];
	const end = mark.points.at(-1);
	if (!start || !end) return;
	ctx.strokeStyle = mark.color;
	ctx.fillStyle = mark.color;
	ctx.lineWidth = 3;
	ctx.lineCap = "round";
	ctx.beginPath();
	if (mark.tool === "text") {
		ctx.font = "bold 20px sans-serif";
		ctx.textAlign = "left";
		ctx.textBaseline = "top";
		ctx.fillText(mark.text, start.x, start.y);
		return;
	}
	if (mark.tool === "box") {
		ctx.strokeRect(start.x, start.y, end.x - start.x, end.y - start.y);
		return;
	}
	ctx.moveTo(start.x, start.y);
	for (const point of mark.points) ctx.lineTo(point.x, point.y);
	ctx.stroke();
	if (mark.tool !== "arrow") return;
	const angle = Math.atan2(end.y - start.y, end.x - start.x);
	ctx.beginPath();
	ctx.moveTo(end.x, end.y);
	ctx.lineTo(end.x - 15 * Math.cos(angle - .5), end.y - 15 * Math.sin(angle - .5));
	ctx.moveTo(end.x, end.y);
	ctx.lineTo(end.x - 15 * Math.cos(angle + .5), end.y - 15 * Math.sin(angle + .5));
	ctx.stroke();
}
async function render(shot, marks) {
	const { canvas, ctx } = canvasFor(shot.width, shot.height);
	ctx.drawImage(await loadImage(shot.url), 0, 0);
	for (const mark of marks) drawMark(ctx, mark);
	return canvas;
}
function MarkupEditor({ shot, onSave, onCancel }) {
	const [tool, setTool] = useState("pen");
	const [color, setColor] = useState(COLORS[0]);
	const [text, setText] = useState("");
	const [marks, setMarks] = useState([]);
	const [preview, setPreview] = useState(null);
	const [error, setError] = useState("");
	const [cursor, setCursor] = useState({
		x: 20,
		y: 20
	});
	const current = useRef(null);
	const canvasRef = useRef(null);
	const root = useRef(null);
	useModalFocus(root);
	useEffect(() => {
		focusInto(canvasRef.current);
	}, []);
	const toCanvas = (event) => {
		if (event.detail > 0) focusInto(canvasRef.current);
	};
	useEffect(() => {
		let cancelled = false;
		render(shot, preview ? [...marks, preview] : marks).then((canvas) => {
			if (!cancelled) canvasRef.current?.getContext("2d")?.drawImage(canvas, 0, 0);
		}).catch(() => {
			if (!cancelled) setError("Could not draw this screenshot. You can still send the original.");
		});
		return () => {
			cancelled = true;
		};
	}, [
		shot,
		marks,
		preview
	]);
	function begin(point) {
		current.current = {
			tool,
			color,
			text,
			points: [point]
		};
		setPreview(current.current);
	}
	function move(point) {
		const mark = current.current;
		if (!mark) return;
		const points = mark.tool === "pen" ? [...mark.points, point] : [mark.points[0], point];
		current.current = {
			...mark,
			points
		};
		setPreview(current.current);
	}
	function finish() {
		const mark = current.current;
		if (mark) setMarks((previous) => [...previous, mark]);
		current.current = null;
		setPreview(null);
	}
	function point(event) {
		const rect = event.currentTarget.getBoundingClientRect();
		return {
			x: (event.clientX - rect.left) * shot.width / rect.width,
			y: (event.clientY - rect.top) * shot.height / rect.height
		};
	}
	function clear() {
		setMarks([]);
		current.current = null;
		setPreview(null);
	}
	function commitText(event) {
		if (event.code !== "Enter" || event.nativeEvent.isComposing) return;
		event.preventDefault();
		if (!text.trim()) return;
		begin(cursor);
		finish();
		setText("");
		canvasRef.current?.focus();
	}
	function exportMarkup() {
		const complete = current.current ? [...marks, current.current] : marks;
		render(shot, complete).then((canvas) => onSave(complete.length ? canvas.toDataURL("image/png") : null)).catch(() => setError("Could not export markup. You can still send the original."));
	}
	useEffect(() => {
		const shortcuts = (event) => {
			const command = markupAction(event);
			if (!command) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const actions = {
				cancel: onCancel,
				export: exportMarkup,
				undo: () => setMarks((previous) => previous.slice(0, -1)),
				clear
			};
			if (actions[command]) actions[command]();
			else if (toolKeys[command]) setTool(toolKeys[command]);
			else setColor(COLORS[Number(command)]);
		};
		window.addEventListener("keydown", shortcuts, true);
		return () => window.removeEventListener("keydown", shortcuts, true);
	});
	function keyboard(event) {
		if (event.code === "Space") {
			event.preventDefault();
			if (current.current) finish();
			else begin(cursor);
			return;
		}
		const direction = {
			ArrowLeft: {
				x: -10,
				y: 0
			},
			ArrowRight: {
				x: 10,
				y: 0
			},
			ArrowUp: {
				x: 0,
				y: -10
			},
			ArrowDown: {
				x: 0,
				y: 10
			}
		}[event.code];
		if (!direction) return;
		event.preventDefault();
		const next = {
			x: Math.max(0, Math.min(shot.width, cursor.x + direction.x)),
			y: Math.max(0, Math.min(shot.height, cursor.y + direction.y))
		};
		setCursor(next);
		move(next);
	}
	return /* @__PURE__ */ jsxs("div", {
		ref: root,
		className: "fb-editor",
		role: "dialog",
		"aria-modal": "true",
		"aria-label": "Mark up screenshot",
		children: [
			/* @__PURE__ */ jsxs("div", {
				className: "fb-toolbar",
				children: [
					/* @__PURE__ */ jsx("strong", { children: "Mark up screenshot" }),
					[
						"pen",
						"box",
						"arrow",
						"text"
					].map((value) => /* @__PURE__ */ jsxs("button", {
						type: "button",
						"aria-label": value,
						"aria-keyshortcuts": {
							pen: "P",
							box: "B",
							arrow: "A",
							text: "T"
						}[value],
						"aria-pressed": tool === value,
						onClick: (event) => {
							setTool(value);
							if (value !== "text") toCanvas(event);
						},
						children: [
							value,
							" ",
							/* @__PURE__ */ jsx(Keycap, { children: {
								pen: "P",
								box: "B",
								arrow: "A",
								text: "T"
							}[value] })
						]
					}, value)),
					COLORS.map((value, index) => /* @__PURE__ */ jsxs("button", {
						type: "button",
						"aria-label": [
							"Red",
							"Teal",
							"Yellow"
						][index],
						"aria-keyshortcuts": String(index + 1),
						"aria-pressed": color === value,
						onClick: (event) => {
							setColor(value);
							toCanvas(event);
						},
						style: { borderBottom: `5px solid ${value}` },
						children: [
							[
								"Red",
								"Teal",
								"Yellow"
							][index],
							" ",
							/* @__PURE__ */ jsx(Keycap, { children: index + 1 })
						]
					}, value)),
					tool === "text" && /* @__PURE__ */ jsx("input", {
						"aria-label": "Text to place",
						value: text,
						onChange: (event) => setText(event.target.value),
						onKeyDown: commitText,
						placeholder: "Type, then place on image"
					}),
					/* @__PURE__ */ jsxs("button", {
						type: "button",
						disabled: !marks.length,
						"aria-label": "Undo",
						"aria-keyshortcuts": `${modifiers().commandKey}+Z`,
						onClick: (event) => {
							setMarks((previous) => previous.slice(0, -1));
							toCanvas(event);
						},
						children: ["Undo ", /* @__PURE__ */ jsx(Keycap, { children: keyLabel("Command", "Z") })]
					}),
					/* @__PURE__ */ jsxs("button", {
						type: "button",
						onClick: (event) => {
							clear();
							toCanvas(event);
						},
						"aria-keyshortcuts": "Delete",
						children: ["Clear ", /* @__PURE__ */ jsx(Keycap, { children: "Del" })]
					}),
					/* @__PURE__ */ jsxs("button", {
						type: "button",
						onClick: onCancel,
						"aria-label": "Cancel",
						"aria-keyshortcuts": "Escape",
						children: ["Cancel ", /* @__PURE__ */ jsx(Keycap, { children: "Esc" })]
					}),
					/* @__PURE__ */ jsxs("button", {
						type: "button",
						onClick: exportMarkup,
						"aria-label": "Use markup",
						"aria-keyshortcuts": "Enter",
						children: ["Done ", /* @__PURE__ */ jsx(Keycap, { children: "↵" })]
					})
				]
			}),
			/* @__PURE__ */ jsxs("p", {
				className: "fb-drawing-help",
				children: ["Draw with mouse, pen or touch. ", /* @__PURE__ */ jsxs("span", {
					className: "fb-keyboard-only",
					children: [
						/* @__PURE__ */ jsx(Keycap, { children: "arrows" }),
						" move cursor · ",
						/* @__PURE__ */ jsx(Keycap, { children: "Space" }),
						" start/finish mark · Position: ",
						cursor.x,
						", ",
						cursor.y,
						"."
					]
				})]
			}),
			/* @__PURE__ */ jsx(StepHints, { step: "editor" }),
			error && /* @__PURE__ */ jsx("p", {
				role: "alert",
				children: error
			}),
			/* @__PURE__ */ jsx("div", {
				className: "fb-canvas-area",
				children: /* @__PURE__ */ jsx("canvas", {
					ref: canvasRef,
					width: shot.width,
					height: shot.height,
					role: "img",
					"aria-label": "Screenshot drawing surface",
					tabIndex: 0,
					onKeyDown: keyboard,
					onPointerDown: (event) => {
						event.currentTarget.setPointerCapture(event.pointerId);
						begin(point(event));
					},
					onPointerMove: (event) => {
						if (current.current) move(point(event));
					},
					onPointerUp: (event) => {
						if (current.current) {
							move(point(event));
							finish();
						}
					},
					onPointerCancel: () => {
						current.current = null;
						setPreview(null);
					}
				})
			})
		]
	});
}
// src/widget/SelectionToolbar.tsx
/** A selection exists: Write note takes focus (on mount and whenever focusKey changes), so Enter presses it. */
function SelectionToolbar({ rect, focusKey = 0, onConfirm, onRedo, onCancel }) {
	const root = useRef(null);
	const confirm = useRef(null);
	useEffect(() => {
		focusInto(confirm.current);
	}, [focusKey]);
	const [position, setPosition] = useState({
		left: 12,
		top: 12
	});
	useLayoutEffect(() => {
		const update = () => {
			const width = root.current?.offsetWidth || 290, height = root.current?.offsetHeight || 52;
			const bottom = ((root.current?.closest(".fb-root")?.querySelector(".fb-step-hints"))?.getBoundingClientRect().top || innerHeight - 88) - 8;
			const below = rect.y + rect.height + 12;
			const top = below + height <= bottom ? below : rect.y - height - 12;
			setPosition({
				left: Math.max(8, Math.min(rect.x, innerWidth - width - 8)),
				top: Math.max(8, Math.min(top, bottom - height))
			});
		};
		update();
		window.addEventListener("resize", update);
		const observer = new ResizeObserver(update);
		if (root.current) observer.observe(root.current);
		const hint = root.current?.closest(".fb-root")?.querySelector(".fb-step-hints");
		if (hint) observer.observe(hint);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", update);
		};
	}, [rect]);
	return /* @__PURE__ */ jsxs("div", {
		ref: root,
		className: "fb-selection-toolbar",
		role: "toolbar",
		"aria-label": "Selection actions",
		style: position,
		children: [
			/* @__PURE__ */ jsxs("button", {
				ref: confirm,
				type: "button",
				onClick: onConfirm,
				"aria-keyshortcuts": "Enter",
				children: ["Write note ", /* @__PURE__ */ jsx(Keycap, { children: "↵" })]
			}),
			/* @__PURE__ */ jsx("button", {
				type: "button",
				onClick: onRedo,
				children: "Redo"
			}),
			/* @__PURE__ */ jsxs("button", {
				type: "button",
				onClick: onCancel,
				"aria-keyshortcuts": "Escape",
				children: ["Cancel ", /* @__PURE__ */ jsx(Keycap, { children: "Esc" })]
			})
		]
	});
}
// src/widget/RegionPicker.tsx
var handles = [
	"nw",
	"n",
	"ne",
	"e",
	"se",
	"s",
	"sw",
	"w"
];
var directions = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1]
};
var clamp = (value, max, min = 0) => Math.max(min, Math.min(max, value));
function dragged(drag, x, y) {
	const rect = drag.rect, dx = x - drag.x, dy = y - drag.y;
	if (drag.kind === "move") return {
		...rect,
		x: clamp(rect.x + dx, innerWidth - rect.width),
		y: clamp(rect.y + dy, innerHeight - rect.height)
	};
	if (drag.kind === "draw") return {
		x: Math.min(drag.x, x),
		y: Math.min(drag.y, y),
		width: Math.abs(dx),
		height: Math.abs(dy)
	};
	const left = drag.kind.includes("w") ? clamp(rect.x + dx, rect.x + rect.width - 1) : rect.x;
	const top = drag.kind.includes("n") ? clamp(rect.y + dy, rect.y + rect.height - 1) : rect.y;
	const right = drag.kind.includes("e") ? clamp(rect.x + rect.width + dx, innerWidth, left + 1) : rect.x + rect.width;
	const bottom = drag.kind.includes("s") ? clamp(rect.y + rect.height + dy, innerHeight, top + 1) : rect.y + rect.height;
	return {
		x: left,
		y: top,
		width: right - left,
		height: bottom - top
	};
}
function moveWithKey(rect, event) {
	const area = rect ?? {
		x: 20,
		y: 100,
		width: Math.min(250, innerWidth - 40),
		height: Math.min(200, innerHeight - 120)
	};
	const delta = directions[event.code], amount = event.shiftKey ? 10 : 1, dx = delta[0] * amount, dy = delta[1] * amount;
	return event.altKey ? {
		...area,
		width: clamp(area.width + dx, innerWidth - area.x, 1),
		height: clamp(area.height + dy, innerHeight - area.y, 1)
	} : {
		...area,
		x: clamp(area.x + dx, innerWidth - area.width),
		y: clamp(area.y + dy, innerHeight - area.height)
	};
}
function RegionPicker({ rect, onChange, onSettle, onCapture, onCancel }) {
	const start = useRef(null);
	const root = useRef(null);
	const surface = useRef(null);
	const [settled, setSettled] = useState(0);
	const selected = !!rect && rect.width > 0 && rect.height > 0;
	useModalFocus(root);
	useEffect(() => {
		if (!selected) focusInto(surface.current);
	}, [selected]);
	useEffect(() => {
		const keyboard = (event) => {
			if (nativeButtonActivation(event)) return;
			if (event.code === "Enter") {
				event.preventDefault();
				event.stopImmediatePropagation();
				if (rect) onCapture(rect);
				return;
			}
			if (!directions[event.code]) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			onChange(moveWithKey(rect, event));
		};
		window.addEventListener("keydown", keyboard, true);
		return () => window.removeEventListener("keydown", keyboard, true);
	}, [
		rect,
		onChange,
		onCapture
	]);
	function begin(event) {
		const target = event.target;
		if (!target.closest(".fb-region-surface, .fb-region-handle")) return;
		event.preventDefault();
		target.setPointerCapture(event.pointerId);
		const x = clamp(event.clientX, innerWidth), y = clamp(event.clientY, innerHeight);
		const inside = rect && x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
		start.current = {
			x,
			y,
			rect: rect ?? {
				x,
				y,
				width: 0,
				height: 0
			},
			kind: target.dataset.handle ?? (inside ? "move" : "draw")
		};
		if (start.current.kind === "draw") onChange(null);
	}
	function move(event) {
		if (!start.current) return null;
		const area = dragged(start.current, clamp(event.clientX, innerWidth), clamp(event.clientY, innerHeight));
		const valid = area.width > 0 && area.height > 0;
		onChange(valid ? area : null);
		return valid ? area : null;
	}
	function end(event) {
		if (!start.current) return;
		const area = move(event);
		start.current = null;
		setSettled((count) => count + 1);
		if (area) onSettle(area);
	}
	return /* @__PURE__ */ jsxs("div", {
		ref: root,
		className: "fb-region",
		role: "dialog",
		"aria-modal": "true",
		"aria-label": "Select screenshot region",
		onPointerDown: begin,
		onPointerMove: move,
		onPointerUp: end,
		onPointerCancel: () => {
			start.current = null;
		},
		children: [
			/* @__PURE__ */ jsx("div", {
				ref: surface,
				className: "fb-region-surface",
				role: "application",
				tabIndex: -1,
				"aria-label": "Drag a region. Arrows move; Shift speeds up; Alt resizes. Enter writes a note."
			}),
			rect && /* @__PURE__ */ jsxs(Fragment, { children: [/* @__PURE__ */ jsx("div", {
				className: "fb-region-box",
				style: {
					left: rect.x,
					top: rect.y,
					width: rect.width,
					height: rect.height
				},
				children: handles.map((handle) => /* @__PURE__ */ jsx("button", {
					type: "button",
					tabIndex: -1,
					className: `fb-region-handle fb-handle-${handle}`,
					"data-handle": handle,
					"aria-label": `Resize ${handle}`
				}, handle))
			}), selected && /* @__PURE__ */ jsx(SelectionToolbar, {
				rect,
				focusKey: settled,
				onConfirm: () => onCapture(rect),
				onRedo: () => onChange(null),
				onCancel
			})] }),
			!rect && /* @__PURE__ */ jsx("div", {
				className: "fb-region-actions",
				children: /* @__PURE__ */ jsxs("button", {
					type: "button",
					onClick: onCancel,
					"aria-keyshortcuts": "Escape",
					children: ["Cancel ", /* @__PURE__ */ jsx(Keycap, { children: "Esc" })]
				})
			}),
			/* @__PURE__ */ jsx(StepHints, {
				step: "region",
				locked: !!rect
			})
		]
	});
}
// src/widget/PickerOverlay.tsx
/**
* Element and Section modes. With nothing locked, focus sits on the picker panel, where Enter
* selects the hovered target and ↑/↓ change it; a focused app control keeps focus (a global
* shortcut from the page), since Enter selects that control. A locked target focuses Write note.
*/
function PickerOverlay({ step, hover, focusKey, onConfirm, onRedo, onCancel }) {
	const panel = useRef(null);
	const locked = !!hover?.locked;
	useEffect(() => {
		if (!locked && !onAppControl()) focusInto(panel.current);
	}, [locked]);
	const label = step === "section" ? "Select a section" : "Select an element";
	return /* @__PURE__ */ jsxs(Fragment, { children: [
		/* @__PURE__ */ jsxs("section", {
			ref: panel,
			className: "fb-panel fb-pick-hint",
			"aria-label": label,
			tabIndex: -1,
			children: [
				label,
				" ",
				/* @__PURE__ */ jsxs("button", {
					type: "button",
					onClick: onCancel,
					"aria-keyshortcuts": "Escape",
					children: ["Cancel ", /* @__PURE__ */ jsx(Keycap, { children: "Esc" })]
				})
			]
		}),
		/* @__PURE__ */ jsx(StepHints, {
			step,
			locked
		}),
		hover && /* @__PURE__ */ jsx("div", {
			className: `fb-highlight ${hover.locked ? "fb-locked" : ""}`,
			style: {
				left: hover.rect.x,
				top: hover.rect.y,
				width: hover.rect.width,
				height: hover.rect.height
			},
			children: /* @__PURE__ */ jsx("span", { children: hover.label })
		}),
		hover?.locked && /* @__PURE__ */ jsx(SelectionToolbar, {
			rect: hover.rect,
			focusKey,
			onConfirm,
			onRedo,
			onCancel
		})
	] });
}
// src/widget/outboxStore.ts
var DB = "fm-feedback-outbox";
var TABLE = "items";
function openDb() {
	return new Promise((resolve) => {
		try {
			const factory = globalThis.indexedDB;
			if (!factory) {
				resolve(null);
				return;
			}
			const request = factory.open(DB, 1);
			request.onupgradeneeded = () => {
				request.result.createObjectStore(TABLE, { keyPath: "id" });
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = request.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}
function run(db, mode, act) {
	return new Promise((resolve, reject) => {
		const tx = db.transaction(TABLE, mode);
		const request = act(tx.objectStore(TABLE));
		tx.oncomplete = () => resolve(request.result);
		tx.onerror = tx.onabort = () => reject(tx.error);
	});
}
/** IndexedDB holds the queue (the items can be several MB of data URLs); with no IndexedDB, a Map does. */
function openStore() {
	const memory = /* @__PURE__ */ new Map();
	const open = openDb();
	const ready = open.then((db) => db !== null);
	const use = async (onDb, onMemory) => {
		const db = await open;
		if (!db) return onMemory();
		try {
			return await onDb(db);
		} catch {
			return onMemory();
		}
	};
	return {
		ready,
		load: () => use((db) => run(db, "readonly", (table) => table.getAll()), () => [...memory.values()]),
		put: (record) => use(async (db) => {
			await run(db, "readwrite", (table) => table.put(record));
		}, () => {
			memory.set(record.id, record);
		}),
		remove: (id) => use(async (db) => {
			await run(db, "readwrite", (table) => table.delete(id));
		}, () => {
			memory.delete(id);
		})
	};
}
// src/widget/FeedbackWidget.tsx
var modes = [
	"region",
	"element",
	"section",
	"page"
];
var modeKeys = [
	"R",
	"E",
	"S",
	"P"
];
var JOB_MAX_AGE = 2e4;
function startCapture(mode, target) {
	return mode === "page" ? capturePage(target) : captureViewport(target.rect);
}
function pillText({ pending, failed }) {
	return [pending ? `${pending} sending` : "", failed ? `${failed} failed` : ""].filter(Boolean).join(", ");
}
function FeedbackWidget({ endpoint = "/__feedback" }) {
	const base = endpoint.replace(/\/$/, "");
	const [outbox] = useState(() => new Outbox$1(base, openStore()));
	outbox.endpoint = base;
	useEffect(() => {
		outbox.start();
		return () => outbox.stop();
	}, [outbox]);
	return /* @__PURE__ */ jsx(OutboxContext.Provider, {
		value: outbox,
		children: /* @__PURE__ */ jsx(FeedbackPanel, {
			outbox,
			endpoint: base
		})
	});
}
function FeedbackPanel({ outbox, endpoint }) {
	const [step, setStep] = useState("closed");
	const [mode, setMode] = useState(null);
	const [region, setRegion] = useState(null);
	const [help, setHelp] = useState(false);
	const [draft, setDraft] = useState(null);
	const [note, setNote] = useState("");
	const [annotated, setAnnotated] = useState(null);
	const [saved, setSaved] = useState(false);
	const generation = useRef(0);
	const job = useRef(null);
	const launcher = useRef(null);
	const previousStep = useRef(step);
	const root = useRef(null);
	const opener = useRef(null);
	const savedClose = useRef(false);
	const returnTo = useRef(null);
	useFeedbackLayer(root);
	const queue = useOutboxSnapshot();
	useEffect(() => {
		installCapture();
	}, []);
	useEffect(() => {
		if (!saved) return;
		const timer = window.setTimeout(() => setSaved(false), 4e3);
		return () => window.clearTimeout(timer);
	}, [saved]);
	useEffect(() => {
		const from = previousStep.current;
		previousStep.current = step;
		if (step === "closed") {
			if (from !== "closed") restoreFocus(savedClose.current ? opener.current : null, launcher.current);
			opener.current = null;
			savedClose.current = false;
			return;
		}
		if (step !== "toolbar" && step !== "list") return;
		const panel = root.current?.querySelector(".fb-panel"), choice = returnTo.current;
		returnTo.current = null;
		focusInto(choice && panel?.querySelector(`[data-choice="${choice}"]`) || panel?.querySelector("button"));
	}, [step]);
	const remember = () => {
		if (step !== "closed") return;
		const active = document.activeElement;
		opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
	};
	const warm = useCallback((mode, target) => {
		const key = JSON.stringify([
			mode,
			target,
			scrollX,
			scrollY,
			innerWidth,
			innerHeight
		]);
		if (job.current?.key === key && performance.now() - job.current.at < JOB_MAX_AGE) return job.current.promise;
		const promise = startCapture(mode, target);
		promise.catch(() => {});
		job.current = {
			key,
			at: performance.now(),
			promise
		};
		return promise;
	}, []);
	const capture = useCallback((mode, target) => {
		const token = ++generation.current;
		const pending = warm(mode, target);
		const current = (change) => setDraft((draft) => draft?.pending === pending ? {
			...draft,
			...change
		} : draft);
		setSaved(false);
		setAnnotated(null);
		setDraft({
			mode,
			target,
			context: getContext(),
			pending,
			capture: null,
			failed: false
		});
		setStep("note");
		pending.then((result) => {
			if (generation.current === token) current({ capture: result });
		}, () => {
			if (generation.current === token) current({ failed: true });
		});
	}, [warm]);
	const warmElement = useCallback((target) => {
		warm(mode === "section" ? "section" : "element", target).catch(() => {});
	}, [warm, mode]);
	const pick = useCallback((target) => {
		capture(mode === "section" ? "section" : "element", target);
	}, [capture, mode]);
	const selectingElement = step === "element" || step === "section";
	useCaptureShield(step === "note" && !!draft && !draft.capture && !draft.failed && elementMode(mode) !== null);
	const picker = usePicker(elementMode(mode), selectingElement, pick, warmElement);
	const reset = () => {
		generation.current++;
		job.current = null;
		setDraft(null);
		setNote("");
		setAnnotated(null);
		setRegion(null);
		picker.clear();
		setHelp(false);
	};
	const choose = (choice) => {
		remember();
		reset();
		setMode(choice);
		setSaved(false);
		if (choice === "page") capture(choice, pageSize());
		else setStep(choice);
	};
	const discard = () => {
		returnTo.current = mode;
		reset();
		setMode(null);
		setStep("toolbar");
	};
	const back = () => {
		if (help) {
			setHelp(false);
			return;
		}
		returnTo.current = step === "list" ? "list" : mode;
		const actions = {
			editor: () => setStep("note"),
			note: () => setStep(mode === "page" ? "toolbar" : mode ?? "toolbar"),
			region: () => {
				if (region) setRegion(null);
				else setStep("toolbar");
			},
			element: () => {
				if (picker.hasSelection) picker.clear();
				else setStep("toolbar");
			},
			section: () => {
				if (picker.hasSelection) picker.clear();
				else setStep("toolbar");
			}
		};
		if (actions[step]) {
			actions[step]();
			return;
		}
		generation.current++;
		setStep(step === "toolbar" ? "closed" : "toolbar");
	};
	const toggle = () => {
		remember();
		returnTo.current = null;
		reset();
		setMode(null);
		setStep(step === "closed" ? "toolbar" : "closed");
	};
	useShortcuts(step, (command) => {
		const actions = {
			toggle,
			back,
			save,
			draw: () => {
				if (draft?.capture) setStep("editor");
			},
			help: () => setHelp((value) => !value),
			list: () => {
				remember();
				reset();
				setStep("list");
			}
		};
		if (actions[command]) actions[command]();
		else if (modes.includes(command)) choose(command);
	});
	function save() {
		if (!draft || !note.trim()) return;
		const text = note, drawn = annotated, taken = draft, live = getContext();
		outbox.enqueue({
			id: newId(),
			label: text.trim().split("\n")[0].slice(0, 80),
			text,
			capture: taken.capture ?? taken.pending,
			build: (result) => feedbackBody(taken, result, text, drawn, live)
		});
		reset();
		setMode(null);
		setSaved(true);
		savedClose.current = true;
		setStep("closed");
	}
	return /* @__PURE__ */ jsxs("div", {
		className: "fb-root",
		"data-feedback-root": true,
		ref: root,
		children: [
			/* @__PURE__ */ jsx("div", {
				className: "fb-launchers",
				children: /* @__PURE__ */ jsxs("button", {
					ref: launcher,
					type: "button",
					className: `fb-launcher${queue.failed ? " fb-launcher-warn" : ""}`,
					"aria-expanded": step !== "closed",
					"aria-keyshortcuts": "Alt+Shift+F",
					onClick: toggle,
					children: [
						"Feedback ",
						/* @__PURE__ */ jsx(Keycap, { children: keyLabel("Alt", "Shift", "F") }),
						queue.items.length > 0 && /* @__PURE__ */ jsxs("span", {
							className: "fb-pill-count",
							children: [" · ", pillText(queue)]
						})
					]
				})
			}),
			saved && /* @__PURE__ */ jsx("div", {
				className: "fb-toast",
				role: "status",
				children: "Queued"
			}),
			step === "toolbar" && /* @__PURE__ */ jsxs("section", {
				className: "fb-panel fb-capture-toolbar",
				"aria-label": "Feedback toolbar",
				children: [
					/* @__PURE__ */ jsxs("div", {
						className: "fb-toolbar",
						children: [
							modes.map((mode, index) => /* @__PURE__ */ jsxs("button", {
								type: "button",
								"data-choice": mode,
								"aria-label": [
									"Region",
									"Element",
									"Section",
									"Full page"
								][index],
								"aria-keyshortcuts": `${modeKeys[index]} ${index + 1}`,
								onClick: () => choose(mode),
								children: [
									[
										"Region",
										"Element",
										"Section",
										"Full page"
									][index],
									" ",
									/* @__PURE__ */ jsx(Keycap, { children: modeKeys[index] })
								]
							}, mode)),
							/* @__PURE__ */ jsxs("button", {
								type: "button",
								"data-choice": "list",
								"aria-label": "My feedback",
								"aria-keyshortcuts": "L",
								onClick: () => setStep("list"),
								children: ["My feedback ", /* @__PURE__ */ jsx(Keycap, { children: "L" })]
							}),
							/* @__PURE__ */ jsxs("button", {
								type: "button",
								"aria-label": "Shortcuts",
								"aria-keyshortcuts": "?",
								"aria-expanded": help,
								onClick: () => setHelp((value) => !value),
								children: [/* @__PURE__ */ jsx(Keycap, { children: "?" }), " Shortcuts"]
							})
						]
					}),
					/* @__PURE__ */ jsx(FirstRunTip, {}),
					help && /* @__PURE__ */ jsx(ShortcutHelp, {})
				]
			}),
			selectingElement && /* @__PURE__ */ jsx(PickerOverlay, {
				step,
				hover: picker.hover,
				focusKey: picker.focusKey,
				onConfirm: picker.confirm,
				onRedo: () => {
					job.current = null;
					picker.clear();
				},
				onCancel: discard
			}),
			step === "note" && draft && /* @__PURE__ */ jsx(FeedbackDraft, {
				note,
				shot: draft.capture?.shot ?? null,
				failed: draft.failed,
				annotated,
				clipped: draft.capture?.clipped,
				rect: "rect" in draft.target ? draft.target.rect : void 0,
				onNote: setNote,
				onEdit: () => {
					if (draft.capture) setStep("editor");
				},
				onSave: save,
				onCancel: discard
			}),
			step === "list" && /* @__PURE__ */ jsx(FeedbackList, {
				endpoint,
				onClose: back
			}),
			step === "region" && /* @__PURE__ */ jsx(RegionPicker, {
				rect: region,
				onChange: (rect) => {
					if (!rect) job.current = null;
					setRegion(rect);
				},
				onSettle: (rect) => {
					warm("region", { rect }).catch(() => {});
				},
				onCapture: (rect) => capture("region", { rect }),
				onCancel: discard
			}),
			step === "editor" && draft?.capture && /* @__PURE__ */ jsx(MarkupEditor, {
				shot: draft.capture.shot,
				onSave: (url) => {
					setAnnotated(url);
					setStep("note");
				},
				onCancel: () => setStep("note")
			})
		]
	});
}
function ShortcutHelp() {
	const { command, alt } = modifiers();
	return /* @__PURE__ */ jsxs("aside", {
		className: "fb-shortcut-help",
		"aria-label": "Keyboard shortcuts",
		children: [
			/* @__PURE__ */ jsxs("p", { children: [
				alt,
				"+Shift+F: toolbar · ",
				alt,
				"+Shift+R/E/S/P: Region / Element / Section / Full page · ",
				alt,
				"+Shift+L: My feedback"
			] }),
			/* @__PURE__ */ jsx("p", { children: "Toolbar: R/E/S/P or 1–4: modes · L: My feedback · ?: shortcuts" }),
			/* @__PURE__ */ jsx("p", { children: "Selection: Enter: Write note · Esc: back · ↑/↓: parent/child · Region arrows: move 1 px, Shift: 10 px, Alt: resize" }),
			/* @__PURE__ */ jsxs("p", { children: [
				"Note: ",
				command,
				"↵: Save · ",
				alt,
				"+D: Draw on it · Esc: back"
			] }),
			/* @__PURE__ */ jsxs("p", { children: [
				"Markup: P: pen · B: box · A: arrow · T: text · 1/2/3: colour · Delete: Clear · ",
				command,
				"+Z: Undo · Enter: Use markup · Esc: cancel · Space: start/finish mark · arrows: move cursor"
			] })
		]
	});
}
function elementMode(mode) {
	return mode === "element" || mode === "section" ? mode : null;
}
// src/widget/FeedbackErrorBoundary.tsx
var FeedbackErrorBoundary = class extends Component {
	state = { failed: false };
	warned = false;
	static getDerivedStateFromError() {
		return { failed: true };
	}
	componentDidCatch(error) {
		if (this.warned) return;
		this.warned = true;
		console.warn("Feedback widget unavailable", error);
	}
	render() {
		return this.state.failed ? null : this.props.children;
	}
};
export { FeedbackErrorBoundary, FeedbackWidget };
