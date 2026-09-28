(() => {
	"use strict";

	const CACHE_KEY = "contentCoreLookupCache";
	const MAX_CONTEXT_LENGTH = 5000;
	let selectionTimer;
	let selectedText = "";
	let selectedContext = "";
	let selectionData = null;
	let currentDefinition = "";
	let currentTone = "";
	let currentSynonym = "";
	let lookupHost = null;
	let shadowRoot = null;
	let savedRange = null;
	let currentTheme = "warm-calm";
	let currentHighlightMode = "traditional";
	let pointerOverlays = [];

	const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

	function escapeHtml(text) {
		const div = document.createElement("div");
		div.textContent = text || "";
		return div.innerHTML;
	}

	function findNearestHeading(element) {
		const headingSelector = "h1, h2, h3, h4, h5, h6, [role='heading']";
		let current = element;
		while (current && current !== document.body && current !== document.documentElement) {
			let sibling = current.previousElementSibling;
			while (sibling) {
				if (sibling.matches(headingSelector)) {
					const text = clean(sibling.innerText || sibling.textContent || "");
					if (text) return text;
				}
				const headings = sibling.querySelectorAll(headingSelector);
				if (headings.length > 0) {
					for (let i = headings.length - 1; i >= 0; i--) {
						const text = clean(headings[i].innerText || headings[i].textContent || "");
						if (text) return text;
					}
				}
				sibling = sibling.previousElementSibling;
			}
			current = current.parentElement;
			if (current && current !== document.body && current !== document.documentElement) {
				if (current.matches(headingSelector)) {
					const text = clean(current.innerText || current.textContent || "");
					if (text) return text;
				}
			}
		}
		return "";
	}

	function getContext(selection) {
		const selected = clean(selection.toString());
		const anchor = selection.anchorNode;
		const anchorElement = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
		const contextElement = anchorElement?.closest("p, li, blockquote, article, section") || anchorElement;
		const text = clean(contextElement?.innerText || contextElement?.textContent || document.body?.innerText || "");
		if (!selected || !text) return selected;

		let baseContext = text;
		const index = text.toLowerCase().indexOf(selected.toLowerCase());
		if (index < 0) {
			baseContext = text.slice(0, MAX_CONTEXT_LENGTH);
		} else if (text.length > MAX_CONTEXT_LENGTH) {
			const sentenceStart = Math.max(
				text.lastIndexOf(".", index - 1),
				text.lastIndexOf("!", index - 1),
				text.lastIndexOf("?", index - 1)
			) + 1;
			const sentenceEndCandidates = [
				text.indexOf(".", index + selected.length),
				text.indexOf("!", index + selected.length),
				text.indexOf("?", index + selected.length)
			].filter((position) => position >= 0);
			const sentenceEnd = sentenceEndCandidates.length ? Math.min(...sentenceEndCandidates) + 1 : text.length;
			baseContext = text.slice(sentenceStart, sentenceEnd).trim();
		}

		const heading = findNearestHeading(contextElement);
		const fullContext = heading ? `[Heading: ${heading}] ${baseContext}` : baseContext;
		return fullContext.slice(0, MAX_CONTEXT_LENGTH);
	}

	function removeCard() {
		lookupHost?.remove();
		lookupHost = null;
		shadowRoot = null;
	}

	// Helper to check if selection range intersects any existing highlight
	function isRangeHighlighted(range) {
		if (!range) return false;
		const startParent = range.startContainer.nodeType === Node.ELEMENT_NODE
			? range.startContainer
			: range.startContainer.parentElement;
		const endParent = range.endContainer.nodeType === Node.ELEMENT_NODE
			? range.endContainer
			: range.endContainer.parentElement;

		if (startParent?.closest(".cc-web-highlight") || endParent?.closest(".cc-web-highlight")) {
			return true;
		}
		if (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE) {
			if (range.commonAncestorContainer.closest(".cc-web-highlight")) return true;
			if (range.commonAncestorContainer.querySelector(".cc-web-highlight")) return true;
		}
		return false;
	}

	// Unwrap highlight mark cleanly
	function unwrapHighlight(mark) {
		const parent = mark.parentNode;
		if (!parent) return;
		while (mark.firstChild) {
			parent.insertBefore(mark.firstChild, mark);
		}
		parent.removeChild(mark);
		parent.normalize();
	}

	// Temporary Highlight toggle on normal webpage
	function toggleHighlight() {
		const range = savedRange || (window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null);
		if (!range) return;

		const startParent = range.startContainer.nodeType === Node.ELEMENT_NODE
			? range.startContainer
			: range.startContainer.parentElement;
		const endParent = range.endContainer.nodeType === Node.ELEMENT_NODE
			? range.endContainer
			: range.endContainer.parentElement;

		const existingMarks = new Set();
		const m1 = startParent?.closest(".cc-web-highlight");
		const m2 = endParent?.closest(".cc-web-highlight");
		if (m1) existingMarks.add(m1);
		if (m2) existingMarks.add(m2);

		if (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE) {
			const m3 = range.commonAncestorContainer.closest(".cc-web-highlight");
			if (m3) existingMarks.add(m3);
			range.commonAncestorContainer.querySelectorAll(".cc-web-highlight").forEach((el) => {
				if (range.intersectsNode(el)) existingMarks.add(el);
			});
		}

		if (existingMarks.size > 0) {
			existingMarks.forEach((mark) => unwrapHighlight(mark));
			removePointerOverlay();
			const highlightBtn = shadowRoot?.querySelector('[data-action="highlight"]');
			highlightBtn?.classList.remove("active");
		} else {
			const createdMarks = applyHighlightToRange(range, "cc-web-highlight");
			if (createdMarks.length > 0) {
				const highlightBtn = shadowRoot?.querySelector('[data-action="highlight"]');
				highlightBtn?.classList.add("active");
				if (createdMarks[0]) showPointerHighlight(createdMarks[0]);
			}
		}

		window.getSelection()?.removeAllRanges();
		setTimeout(removeCard, 350);
	}

	// Robust highlight applicator — works across any DOM structure including
	// slides, styled spans, and complex layouts. Never uses surroundContents().
	function applyHighlightToRange(range, className) {
		const createdMarks = [];

		// Collect all text nodes that intersect the range
		const walker = document.createTreeWalker(
			range.commonAncestorContainer,
			NodeFilter.SHOW_TEXT,
			{
				acceptNode: (node) => {
					if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
					if (!node.textContent.trim()) return NodeFilter.FILTER_SKIP;
					return NodeFilter.FILTER_ACCEPT;
				}
			}
		);

		const textNodes = [];
		// If the entire range is within one text node
		if (range.startContainer === range.endContainer &&
			range.startContainer.nodeType === Node.TEXT_NODE) {
			textNodes.push(range.startContainer);
		} else {
			while (walker.nextNode()) textNodes.push(walker.currentNode);
		}

		for (const node of textNodes) {
			// Skip nodes already inside a highlight
			if (node.parentElement?.closest(`.${className}`)) continue;

			try {
				const nodeRange = document.createRange();

				if (node === range.startContainer && node === range.endContainer) {
					nodeRange.setStart(node, range.startOffset);
					nodeRange.setEnd(node, range.endOffset);
				} else if (node === range.startContainer) {
					nodeRange.setStart(node, range.startOffset);
					nodeRange.setEnd(node, node.length);
				} else if (node === range.endContainer) {
					nodeRange.setStart(node, 0);
					nodeRange.setEnd(node, range.endOffset);
				} else {
					nodeRange.selectNodeContents(node);
				}

				if (nodeRange.collapsed) continue;

				// Use extractContents + insertNode instead of surroundContents
				// — works correctly even when elements cross range boundaries
				const mark = document.createElement("mark");
				mark.className = className;
				mark.appendChild(nodeRange.extractContents());
				nodeRange.insertNode(mark);
				// Normalize parent to merge adjacent text nodes
				mark.parentNode?.normalize();
				createdMarks.push(mark);
			} catch (e) {
				// Last resort — skip this node silently
				console.warn("[arth.find] Could not highlight node:", e);
			}
		}

		return createdMarks;
	}

	// Pointer-only highlight — no yellow mark, just the animated border+cursor
	function doPointerHighlight() {
		const range = savedRange || (window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null);
		if (!range) return;

		const startParent = range.startContainer.nodeType === Node.ELEMENT_NODE
			? range.startContainer : range.startContainer.parentElement;
		const endParent = range.endContainer.nodeType === Node.ELEMENT_NODE
			? range.endContainer : range.endContainer.parentElement;

		const existingMarks = new Set();
		[startParent?.closest(".cc-web-highlight"), endParent?.closest(".cc-web-highlight")].forEach(m => m && existingMarks.add(m));
		if (range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE) {
			const m = range.commonAncestorContainer.closest(".cc-web-highlight");
			if (m) existingMarks.add(m);
			range.commonAncestorContainer.querySelectorAll(".cc-web-highlight").forEach(el => {
				if (range.intersectsNode(el)) existingMarks.add(el);
			});
		}

		if (existingMarks.size > 0) {
			existingMarks.forEach(mark => unwrapHighlight(mark));
			removePointerOverlay();
			shadowRoot?.querySelector('[data-action="highlight"]')?.classList.remove("active");
			window.getSelection()?.removeAllRanges();
			setTimeout(removeCard, 350);
			return;
		}

		// Use the same robust applicator as toggleHighlight, with pointer-only class
		const createdMarks = applyHighlightToRange(range, "cc-web-highlight cc-pointer-only");

		if (createdMarks.length > 0) {
			requestAnimationFrame(() => {
				removePointerOverlay();
				const accent = getThemeAccent();
				for (const mark of createdMarks) {
					const rect = mark.getBoundingClientRect();
					if (!rect.width || !rect.height) continue;
					const overlay = document.createElement("div");
					overlay.className = "cc-pointer-highlight-overlay";
					overlay.style.cssText = `left:${rect.left + window.scrollX}px;top:${rect.top + window.scrollY}px;width:${rect.width}px;height:${rect.height}px;`;
					const border = document.createElement("div");
					border.className = "cc-pointer-border";
					border.style.borderColor = accent;
					const pointer = document.createElement("div");
					pointer.className = "cc-pointer-cursor";
					pointer.style.cssText = `left:${rect.width + 4}px;top:${rect.height + 4}px;color:${accent};`;
					pointer.innerHTML = `<svg stroke="currentColor" fill="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 16 16" height="100%" width="100%" xmlns="http://www.w3.org/2000/svg"><path d="M14.082 2.182a.5.5 0 0 1 .103.557L8.528 15.467a.5.5 0 0 1-.917-.007L5.57 10.694.803 8.652a.5.5 0 0 1-.006-.916l12.728-5.657a.5.5 0 0 1 .556.103z"></path></svg>`;
					overlay.appendChild(border);
					overlay.appendChild(pointer);
					document.documentElement.appendChild(overlay);
					pointerOverlays.push(overlay);
				}
				shadowRoot?.querySelector('[data-action="highlight"]')?.classList.add("active");
			});
		}

		window.getSelection()?.removeAllRanges();
		setTimeout(removeCard, 350);
	}

	async function getCache() {
		return (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
	}

	function renderCardError(cardContent, title, desc, hint = "") {
		cardContent.innerHTML = `
			<div class="cc-card-error-container">
				<div class="cc-error-title">${escapeHtml(title)}</div>
				<div class="cc-error-desc">${escapeHtml(desc)}</div>
				${hint ? `<div class="cc-error-hint">${escapeHtml(hint)}</div>` : ""}
			</div>
		`;
	}

	// Call backend API /define
	async function explainSelection(cardContent) {
		if (!shadowRoot || !selectedText) return;

		let settings;
		try {
			settings = await ContentCoreCrypto.readSettings();
		} catch (err) {
			console.error("[arth.find] Failed to read settings:", err);
			settings = {};
		}

		const hasCredential = Boolean(
			settings.contentCoreCredentialId && settings.contentCoreCredentialToken
		);

		if (!hasCredential) {
			renderCardError(
				cardContent,
				"API Key Setup Required",
				"Please configure your AI provider (Google Gemini, OpenAI, or NVIDIA NIM) in the Arth.Find extension settings to get word definitions.",
				"Click the Arth.Find icon in your browser toolbar to enter your key."
			);
			return;
		}

		const context = selectedContext;
		const cacheKey = `${location.href}::${selectedText.toLowerCase()}::${context}`;
		const cache = await getCache();

		if (cache[cacheKey]) {
			const cached = cache[cacheKey];
			const meaning = typeof cached === "object" ? cached.meaning : cached;
			const tone = typeof cached === "object" ? cached.tone : "";
			const synonym = typeof cached === "object" ? cached.synonym : "";
			currentDefinition = meaning;
			currentTone = tone;
			currentSynonym = synonym;
			renderCardDefinition(cardContent, meaning, tone, synonym);
			return;
		}

		if (typeof navigator !== "undefined" && navigator.onLine === false) {
			renderCardError(
				cardContent,
				"No Internet Connection",
				"Your device appears to be offline. Please check your network and try again."
			);
			return;
		}

		cardContent.innerHTML = `
			<div class="cc-shimmer-wrap">
				<div class="cc-shimmer-line full"></div>
				<div class="cc-shimmer-line long"></div>
				<div class="cc-shimmer-line mid"></div>
				<div class="cc-shimmer-line short"></div>
			</div>
		`;

		try {
			const endpoint = settings.contentCoreEndpoint || ContentCoreCrypto.BACKEND_ENDPOINT;

			const payload = {
				word: selectionData.word,
				target: selectionData.word,
				context: selectionData.context,
				credential_id: settings.contentCoreCredentialId,
				credential_token: settings.contentCoreCredentialToken
			};

			let response;
			try {
				response = await fetch(endpoint, {
					method: "POST",
					headers: {
						"Content-Type": "application/json"
					},
					body: JSON.stringify(payload)
				});
			} catch (networkError) {
				if (typeof navigator !== "undefined" && navigator.onLine === false) {
					renderCardError(
						cardContent,
						"No Internet Connection",
						"Your device appears to be offline. Please check your network and try again."
					);
				} else {
					renderCardError(
						cardContent,
						"Connection Failed",
						"Could not connect to the Arth.Find backend. Please ensure the backend server is running and reachable."
					);
				}
				return;
			}

			if (!response.ok) {
				let errTitle = "Service Error";
				let errDesc = `Request failed (${response.status})`;
				try {
					const errorData = await response.json();
					const message = errorData.message || errorData.detail || "";
					if (response.status === 400) {
						const lower = message.toLowerCase();
						if (lower.includes("key") || lower.includes("credential") || lower.includes("auth") || lower.includes("token")) {
							errTitle = "Invalid API Key";
						} else {
							errTitle = "Invalid Request";
						}
						errDesc = message || "Please check your settings or selected text.";
					} else if (response.status === 429) {
						errTitle = "Rate Limit Exceeded";
						errDesc = message || "Too many requests. Please wait a moment before trying again.";
					} else if (response.status === 504) {
						errTitle = "Request Timed Out";
						errDesc = message || "The AI provider took too long to respond. Please try again.";
					} else if (response.status === 503) {
						errTitle = "Service Unavailable";
						errDesc = message || "The definition service is temporarily unavailable. Please try again later.";
					} else {
						errDesc = message || errDesc;
					}
				} catch {
					if (response.status === 429) {
						errTitle = "Rate Limit Exceeded";
						errDesc = "Too many requests. Please wait a moment before trying again.";
					} else if (response.status === 504) {
						errTitle = "Request Timed Out";
						errDesc = "The AI provider took too long to respond. Please try again.";
					} else if (response.status === 503) {
						errTitle = "Service Unavailable";
						errDesc = "The definition service is temporarily unavailable. Please try again later.";
					}
				}
				renderCardError(cardContent, errTitle, errDesc);
				return;
			}

			const result = await response.json();
			const meaning = clean(String(result.meaning || result.definition || result.explanation || result.answer || ""));
			if (!meaning || meaning === "No definition") {
				renderCardError(cardContent, "No Definition", "The AI provider did not return an explanation for this selection.");
				return;
			}

			currentDefinition = meaning;
			currentTone = clean(String(result.tone || ""));
			currentSynonym = clean(String(result.synonym || ""));

			cache[cacheKey] = {
				meaning: currentDefinition,
				tone: currentTone,
				synonym: currentSynonym
			};
			await chrome.storage.local.set({ [CACHE_KEY]: cache });
			renderCardDefinition(cardContent, currentDefinition, currentTone, currentSynonym);
		} catch (error) {
			renderCardError(cardContent, "Unexpected Error", error.message || "An unexpected error occurred.");
		}
	}

	function renderCardDefinition(cardContent, meaning, tone, synonym) {
		let metaHtml = "";
		if (tone || synonym) {
			metaHtml = `<div class="cc-card-meta">`;
			if (tone) {
				metaHtml += `
					<div class="cc-card-meta-row">
						<span class="cc-meta-badge">Tone:</span>
						<span class="cc-meta-value">${escapeHtml(tone)}</span>
					</div>
				`;
			}
			if (synonym) {
				metaHtml += `
					<div class="cc-card-meta-row">
						<span class="cc-meta-badge">Synonym:</span>
						<span class="cc-meta-value">${escapeHtml(synonym)}</span>
					</div>
				`;
			}
			metaHtml += `</div>`;
		}

		cardContent.innerHTML = `
			<div class="cc-card-definition">${escapeHtml(meaning)}</div>
			${metaHtml}
		`;
	}

	async function saveSelection() {
		if (!selectionData || !selectionData.word) return;
		const saved = (await chrome.storage.local.get("contentCoreSavedWords")).contentCoreSavedWords || [];
		const existingIndex = saved.findIndex((item) => item.word === selectedText && item.url === location.href);

		const itemData = {
			word: selectionData.word,
			context: selectionData.context,
			definition: currentDefinition || "",
			url: location.href,
			savedAt: Date.now()
		};

		if (existingIndex >= 0) {
			saved[existingIndex] = itemData;
		} else {
			saved.unshift(itemData);
		}

		await chrome.storage.local.set({ contentCoreSavedWords: saved.slice(0, 100) });

		const saveBtn = shadowRoot?.querySelector('[data-action="save"]');
		if (saveBtn) {
			saveBtn.classList.add("saved-success");
			saveBtn.innerHTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
		}
	}

	function createCard(rect, context) {
		removeCard();
		selectedContext = context;
		currentDefinition = "";
		currentTone = "";
		currentSynonym = "";
		selectionData = { word: selectedText, context: selectedContext };

		lookupHost = document.createElement("div");
		lookupHost.setAttribute("data-thesis-host", "true");
		lookupHost.setAttribute("data-theme", currentTheme);
		shadowRoot = lookupHost.attachShadow({ mode: "closed" });

		const isHighlighted = isRangeHighlighted(savedRange);

		shadowRoot.innerHTML = `
			<style>
				@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&display=swap');

				*, *::before, *::after {
					box-sizing: border-box;
					margin: 0;
					padding: 0;
				}

				:host {
					/* Default — warm-calm light (fallback) */
					--cc-paper: #f8f4e8;
					--cc-line: #e6d5b8;
					--cc-ink: #3b3b3b;
					--cc-ink-soft: #6f675b;
					--cc-accent: #b17a57;
					--cc-accent-soft: #f5ece0;
					--cc-success-bg: #ecfdf5;
					--cc-success-text: #10b981;
					--cc-error-title: #b91c1c;
					--cc-error-text: #dc2626;
					--cc-highlight-mark: rgba(245, 230, 168, 0.6);

					/* Aliases */
					--cc-bg: var(--cc-paper);
					--cc-card-bg: var(--cc-paper);
					--cc-border: var(--cc-line);
					--cc-card-border: var(--cc-line);
					--cc-text: var(--cc-ink);
					--cc-text-strong: var(--cc-ink);
					--cc-text-muted: var(--cc-ink-soft);
					--cc-text-soft: var(--cc-ink-soft);
					--cc-hover-bg: var(--cc-accent-soft);
					--cc-accent-bg: var(--cc-accent-soft);
					--cc-accent-text: var(--cc-accent);
					--cc-spinner-track: var(--cc-line);
					--cc-spinner-active: var(--cc-accent);
					--cc-meta-border: var(--cc-line);
					--cc-meta-badge: var(--cc-ink-soft);
				}

				/* ── Light themes ── */
				:host([data-theme="warm-calm"]) {
					--cc-paper: #f8f4e8;
					--cc-line: #e6d5b8;
					--cc-ink: #3b3b3b;
					--cc-ink-soft: #6f675b;
					--cc-accent: #b17a57;
					--cc-accent-soft: #f5ece0;
					--cc-highlight-mark: rgba(245, 230, 168, 0.6);
					--cc-error-title: #b91c1c;
					--cc-error-text: #dc2626;
				}

				:host([data-theme="fresh-calm"]) {
					--cc-paper: #f1f8f3;
					--cc-line: #c6dccc;
					--cc-ink: #2f2f2f;
					--cc-ink-soft: #5f7566;
					--cc-accent: #6b8f71;
					--cc-accent-soft: #e2f0e5;
					--cc-highlight-mark: rgba(245, 230, 168, 0.6);
					--cc-error-title: #b91c1c;
					--cc-error-text: #dc2626;
				}

				:host([data-theme="soft-natural"]) {
					--cc-paper: #eaf4ff;
					--cc-line: #a7c7e7;
					--cc-ink: #3b3b3b;
					--cc-ink-soft: #5d7183;
					--cc-accent: #4a90a4;
					--cc-accent-soft: #d8edf7;
					--cc-highlight-mark: rgba(245, 230, 168, 0.6);
					--cc-error-title: #b91c1c;
					--cc-error-text: #dc2626;
				}

				:host([data-theme="warm-friendly"]) {
					--cc-paper: #fff7e6;
					--cc-line: #ffd8b1;
					--cc-ink: #3b3b3b;
					--cc-ink-soft: #7d6a55;
					--cc-accent: #d9825b;
					--cc-accent-soft: #fdeede;
					--cc-highlight-mark: rgba(244, 196, 48, 0.5);
					--cc-error-title: #b91c1c;
					--cc-error-text: #dc2626;
				}

				/* ── Dark themes ── */
				:host([data-theme="warm-calm-dark"]) {
					--cc-paper: #2a2723;
					--cc-line: #45403a;
					--cc-ink: #ede6d8;
					--cc-ink-soft: #a2988a;
					--cc-accent: #c08b63;
					--cc-accent-soft: #3a3028;
					--cc-success-bg: #1a2e1a;
					--cc-success-text: #6ee77a;
					--cc-highlight-mark: rgba(138, 116, 51, 0.55);
					--cc-error-title: #f87171;
					--cc-error-text: #fca5a5;
				}

				:host([data-theme="fresh-calm-dark"]) {
					--cc-paper: #1f2723;
					--cc-line: #38473d;
					--cc-ink: #e1ede4;
					--cc-ink-soft: #93a899;
					--cc-accent: #7fa987;
					--cc-accent-soft: #2a3830;
					--cc-success-bg: #1a2e1a;
					--cc-success-text: #6ee77a;
					--cc-highlight-mark: rgba(85, 112, 63, 0.55);
					--cc-error-title: #f87171;
					--cc-error-text: #fca5a5;
				}

				:host([data-theme="soft-natural-dark"]) {
					--cc-paper: #1e262e;
					--cc-line: #354552;
					--cc-ink: #e2edf7;
					--cc-ink-soft: #93a7b8;
					--cc-accent: #5fa7bc;
					--cc-accent-soft: #263240;
					--cc-success-bg: #1a2e1a;
					--cc-success-text: #6ee77a;
					--cc-highlight-mark: rgba(63, 100, 116, 0.55);
					--cc-error-title: #f87171;
					--cc-error-text: #fca5a5;
				}

				:host([data-theme="warm-friendly-dark"]) {
					--cc-paper: #2b2520;
					--cc-line: #473c33;
					--cc-ink: #f6eadb;
					--cc-ink-soft: #b2a18d;
					--cc-accent: #d9825b;
					--cc-accent-soft: #3c2e24;
					--cc-success-bg: #1a2e1a;
					--cc-success-text: #6ee77a;
					--cc-highlight-mark: rgba(138, 106, 36, 0.55);
					--cc-error-title: #f87171;
					--cc-error-text: #fca5a5;
				}

				/* ── Pill (trigger bar above selection) ── */
				.cc-floating-pill-container {
					position: fixed;
					z-index: 2147483647;
					display: flex;
					flex-direction: column;
					align-items: flex-start;
					font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
					font-size: 14px;
					line-height: 1.5;
					color: var(--cc-text);
					max-height: calc(100vh - 70px);
				}

				.cc-floating-pill-container.cc-dragging {
					user-select: none;
					opacity: 0.92;
				}

				.cc-floating-pill-container.cc-dragging .cc-drag-handle {
					opacity: 1;
				}

				.cc-floating-pill {
					display: flex;
					align-items: center;
					background: var(--cc-bg);
					border: 1px solid var(--cc-border);
					border-radius: 10px;
					box-shadow: 0 4px 16px rgba(0, 0, 0, 0.10), 0 1px 4px rgba(0, 0, 0, 0.06);
					padding: 4px 6px;
					gap: 4px;
					user-select: none;
					flex-shrink: 0;
				}

				.cc-drag-handle {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					width: 20px;
					height: 28px;
					color: var(--cc-ink-soft);
					cursor: grab;
					opacity: 0.45;
					flex-shrink: 0;
					border-radius: 4px;
					transition: opacity 0.15s, color 0.15s;
					margin-right: 2px;
				}

				.cc-drag-handle:hover {
					opacity: 0.85;
					color: var(--cc-ink);
				}

				.cc-explain-btn {
					background: transparent;
					border: none;
					color: var(--cc-ink);
					font-size: 13px;
					font-weight: 600;
					padding: 5px 10px;
					border-radius: 6px;
					cursor: pointer;
					white-space: nowrap;
					font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
					letter-spacing: 0.01em;
					transition: background 0.15s, color 0.15s;
				}

				.cc-explain-btn:hover {
					background: var(--cc-hover-bg);
					color: var(--cc-ink);
				}

				.cc-pill-separator {
					width: 1px;
					height: 18px;
					background-color: var(--cc-card-border);
					margin: 0 2px;
				}

				.cc-pill-icon-btn {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					width: 28px;
					height: 28px;
					border: none;
					background: transparent;
					border-radius: 5px;
					color: var(--cc-meta-badge);
					cursor: pointer;
					padding: 0;
					transition: background 0.15s, color 0.15s;
				}

				.cc-pill-icon-btn:hover {
					background: var(--cc-hover-bg);
					color: var(--cc-text-strong);
				}

				.cc-pill-icon-btn.active {
					background: var(--cc-accent-bg);
					color: var(--cc-accent-text);
				}

				.cc-pill-icon-btn.saved-success {
					color: var(--cc-success-text);
					background: var(--cc-success-bg);
				}

				/* ── Dropdown word card ── */
				.cc-dropdown-card {
					position: relative;
					margin-top: 8px;
					width: 300px;
					background: var(--cc-paper);
					border-radius: 20px;
					box-shadow: 0 1px 2px rgba(38, 38, 74, 0.04), 0 12px 28px rgba(38, 38, 74, 0.13);
					border: 1px solid var(--cc-line);
					overflow-y: auto;
					overflow-x: hidden;
					flex: 1;
					min-height: 0;
					font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
					color: var(--cc-ink);
					animation: ccCardFadeIn 0.15s ease-out;
				}

				@keyframes ccCardFadeIn {
					from { opacity: 0; transform: translateY(-4px); }
					to   { opacity: 1; transform: translateY(0); }
				}

				/* Card body — word, definition, example */
				.cc-card-body {
					padding: 20px 20px 16px;
				}

				.cc-card-head {
					display: flex;
					align-items: baseline;
					justify-content: space-between;
					gap: 8px;
					flex-wrap: wrap;
				}

				.cc-card-word {
					font-family: Georgia, "Iowan Old Style", "Times New Roman", serif;
					font-size: 22px;
					font-weight: 700;
					color: var(--cc-ink);
					letter-spacing: -0.01em;
					overflow-wrap: anywhere;
					flex: 1;
				}

				.cc-card-close {
					border: none;
					background: transparent;
					color: var(--cc-ink-soft);
					cursor: pointer;
					font-size: 18px;
					line-height: 1;
					padding: 2px 6px;
					border-radius: 6px;
					flex-shrink: 0;
					transition: background 0.15s, color 0.15s;
				}

				.cc-card-close:hover {
					background: var(--cc-accent-soft);
					color: var(--cc-ink);
				}

				.cc-card-definition {
					margin-top: 12px;
					font-size: 14px;
					line-height: 1.55;
					color: var(--cc-ink);
					font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
					max-height: 140px;
					overflow-y: auto;
					padding-right: 2px;
				}

				.cc-card-meta {
					margin-top: 8px;
					padding-top: 8px;
					border-top: 1px dashed var(--cc-line);
					display: flex;
					flex-direction: column;
					gap: 5px;
					font-size: 12px;
					font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
				}

				.cc-card-meta-row {
					display: flex;
					align-items: flex-start;
					gap: 6px;
				}

				.cc-meta-badge {
					font-weight: 600;
					color: var(--cc-ink-soft);
					min-width: 58px;
				}

				.cc-meta-value {
					color: var(--cc-ink);
					flex: 1;
				}

				/* Loading shimmer */
				.cc-shimmer-wrap {
					display: flex;
					flex-direction: column;
					gap: 8px;
					padding: 4px 0 2px;
				}

				.cc-shimmer-line {
					height: 11px;
					border-radius: 6px;
					background: linear-gradient(
						90deg,
						var(--cc-line) 25%,
						var(--cc-accent-soft) 50%,
						var(--cc-line) 75%
					);
					background-size: 200% 100%;
					animation: ccShimmer 1.4s ease-in-out infinite;
				}

				.cc-shimmer-line.full  { width: 100%; }
				.cc-shimmer-line.long  { width: 88%; }
				.cc-shimmer-line.mid   { width: 72%; }
				.cc-shimmer-line.short { width: 48%; }

				@keyframes ccShimmer {
					0%   { background-position: 200% 0; }
					100% { background-position: -200% 0; }
				}

				/* Error state */
				.cc-card-error-container {
					padding: 4px 0;
				}

				.cc-error-title {
					font-size: 13.5px;
					font-weight: 600;
					color: var(--cc-error-title);
					margin-bottom: 4px;
				}

				.cc-error-desc {
					font-size: 12.5px;
					line-height: 1.45;
					color: var(--cc-ink-soft);
					margin-bottom: 4px;
				}

				.cc-error-hint {
					font-size: 11.5px;
					color: var(--cc-ink-soft);
					font-style: italic;
				}

				/* Card footer — action buttons */
				.cc-card-footer {
					display: flex;
					align-items: center;
					justify-content: space-between;
					padding: 8px 12px;
					border-top: 1px solid var(--cc-line);
					background: var(--cc-accent-soft);
				}

				.cc-card-btn {
					display: flex;
					align-items: center;
					justify-content: center;
					width: 36px;
					height: 36px;
					border-radius: 10px;
					background: transparent;
					border: none;
					cursor: pointer;
					color: var(--cc-accent);
					transition: background 0.15s ease, transform 0.1s ease, color 0.15s ease;
				}

				.cc-card-btn:hover {
					background: rgba(75, 79, 209, 0.12);
				}

				.cc-card-btn:active {
					transform: scale(0.94);
				}

				.cc-card-btn svg {
					width: 18px;
					height: 18px;
				}

				.cc-card-btn[data-active="true"] {
					color: #fff;
					background: var(--cc-accent);
				}

				.cc-card-btn.saved-success {
					color: var(--cc-success-text);
					background: var(--cc-success-bg);
				}

				/* Toast */
				.cc-card-toast {
					position: absolute;
					left: 50%;
					bottom: 12px;
					transform: translateX(-50%) translateY(6px);
					background: var(--cc-ink);
					color: #fff;
					font-size: 11.5px;
					padding: 4px 10px;
					border-radius: 20px;
					opacity: 0;
					pointer-events: none;
					transition: opacity 0.15s ease, transform 0.15s ease;
					white-space: nowrap;
					z-index: 1;
				}

				.cc-card-toast[data-show="true"] {
					opacity: 1;
					transform: translateX(-50%) translateY(0);
				}

				/* Highlight mode picker */
				.cc-highlight-group {
					position: relative;
					display: inline-flex;
					align-items: center;
				}

				.cc-highlight-chevron {
					display: inline-flex;
					align-items: center;
					justify-content: center;
					width: 14px;
					height: 28px;
					border: none;
					background: transparent;
					border-radius: 0 5px 5px 0;
					color: var(--cc-meta-badge);
					cursor: pointer;
					padding: 0;
					transition: background 0.15s, color 0.15s;
				}

				.cc-highlight-chevron:hover {
					background: var(--cc-hover-bg);
					color: var(--cc-text-strong);
				}

				.cc-highlight-mode-panel {
					position: absolute;
					top: calc(100% + 5px);
					left: 0;
					background: var(--cc-bg);
					border: 1px solid var(--cc-border);
					border-radius: 8px;
					box-shadow: 0 6px 20px rgba(0,0,0,0.12);
					padding: 5px;
					display: none;
					flex-direction: column;
					gap: 2px;
					z-index: 2147483648;
					min-width: 158px;
					animation: ccCardFadeIn 0.12s ease-out;
				}

				.cc-highlight-mode-panel.open {
					display: flex;
				}

				.cc-highlight-mode-label {
					font-size: 10px;
					font-weight: 600;
					letter-spacing: 0.06em;
					text-transform: uppercase;
					color: var(--cc-ink-soft);
					padding: 2px 6px 4px;
				}

				.cc-highlight-mode-btn {
					display: flex;
					align-items: center;
					gap: 8px;
					padding: 6px 8px;
					border-radius: 5px;
					border: none;
					background: transparent;
					cursor: pointer;
					font-size: 12px;
					font-family: inherit;
					color: var(--cc-ink);
					text-align: left;
					width: 100%;
					transition: background 0.12s;
				}

				.cc-highlight-mode-btn:hover {
					background: var(--cc-hover-bg);
				}

				.cc-highlight-mode-btn[data-active="true"] {
					background: var(--cc-accent-soft);
					color: var(--cc-accent);
					font-weight: 600;
				}

				.cc-highlight-mode-btn svg {
					flex-shrink: 0;
				}
				.cc-theme-panel {
					position: absolute;
					top: 42px;
					right: 0;
					background: var(--cc-bg);
					border: 1px solid var(--cc-border);
					border-radius: 10px;
					box-shadow: 0 8px 24px rgba(0,0,0,0.13);
					padding: 8px;
					display: none;
					flex-direction: column;
					gap: 4px;
					z-index: 2147483648;
					min-width: 148px;
					animation: ccCardFadeIn 0.12s ease-out;
				}

				.cc-theme-panel.open {
					display: flex;
				}

				.cc-theme-panel-label {
					font-size: 10px;
					font-weight: 600;
					letter-spacing: 0.06em;
					text-transform: uppercase;
					color: var(--cc-ink-soft);
					padding: 2px 4px 4px;
				}

				.cc-theme-swatch {
					display: flex;
					align-items: center;
					gap: 8px;
					padding: 5px 7px;
					border-radius: 6px;
					border: none;
					background: transparent;
					cursor: pointer;
					font-size: 12px;
					font-family: inherit;
					color: var(--cc-ink);
					text-align: left;
					width: 100%;
					transition: background 0.12s;
				}

				.cc-theme-swatch:hover {
					background: var(--cc-hover-bg);
				}

				.cc-theme-swatch[data-active="true"] {
					background: var(--cc-accent-soft);
					color: var(--cc-accent);
					font-weight: 600;
				}

				.cc-theme-dot {
					width: 11px;
					height: 11px;
					border-radius: 50%;
					flex-shrink: 0;
					border: 1.5px solid rgba(0,0,0,0.08);
				}

				.cc-theme-divider {
					height: 1px;
					background: var(--cc-line);
					margin: 2px 0;
				}

			</style>

			<div class="cc-floating-pill-container">
				<div class="cc-floating-pill">
					<div class="cc-drag-handle" title="Drag to move" aria-hidden="true">
						<svg width="10" height="14" viewBox="0 0 10 14" fill="none" xmlns="http://www.w3.org/2000/svg">
							<circle cx="2.5" cy="2"  r="1.2" fill="currentColor"/>
							<circle cx="7.5" cy="2"  r="1.2" fill="currentColor"/>
							<circle cx="2.5" cy="7"  r="1.2" fill="currentColor"/>
							<circle cx="7.5" cy="7"  r="1.2" fill="currentColor"/>
							<circle cx="2.5" cy="12" r="1.2" fill="currentColor"/>
							<circle cx="7.5" cy="12" r="1.2" fill="currentColor"/>
						</svg>
					</div>
					<button type="button" class="cc-explain-btn" data-action="explain">Explain this</button>
					<div class="cc-pill-separator"></div>
					<div class="cc-highlight-group">
						<button type="button" class="cc-pill-icon-btn ${isHighlighted ? "active" : ""}" data-action="highlight" title="Highlight" aria-label="Highlight text">
							<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
								<path d="m9 11-6 6v3h3l6-6"/>
								<path d="m22 7-4.5-4.5a2.12 2.12 0 0 0-3 0l-4.5 4.5 7.5 7.5 4.5-4.5a2.12 2.12 0 0 0 0-3Z"/>
								<line x1="14.5" y1="5.5" x2="18.5" y2="9.5"/>
							</svg>
						</button>
						<button type="button" class="cc-highlight-chevron" data-action="highlight-mode" title="Choose highlight style" aria-label="Choose highlight style">
							<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
								<polyline points="6 9 12 15 18 9"/>
							</svg>
						</button>
						<div class="cc-highlight-mode-panel" id="cc-highlight-mode-panel">
							<div class="cc-highlight-mode-label">Highlight style</div>
							<button class="cc-highlight-mode-btn" data-mode="traditional">
								<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
									<path d="m9 11-6 6v3h3l6-6"/>
									<path d="m22 7-4.5-4.5a2.12 2.12 0 0 0-3 0l-4.5 4.5 7.5 7.5 4.5-4.5a2.12 2.12 0 0 0 0-3Z"/>
									<line x1="14.5" y1="5.5" x2="18.5" y2="9.5"/>
								</svg>
								Traditional
							</button>
							<button class="cc-highlight-mode-btn" data-mode="pointer">
								<svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" stroke="none" xmlns="http://www.w3.org/2000/svg">
									<path d="M14.082 2.182a.5.5 0 0 1 .103.557L8.528 15.467a.5.5 0 0 1-.917-.007L5.57 10.694.803 8.652a.5.5 0 0 1-.006-.916l12.728-5.657a.5.5 0 0 1 .556.103z"/>
								</svg>
								Pointer highlight
							</button>
						</div>
					</div>
					<button type="button" class="cc-pill-icon-btn" data-action="save" title="Save word" aria-label="Save word">
						<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
							<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
							<polyline points="14 2 14 8 20 8"/>
							<line x1="16" y1="13" x2="8" y2="13"/>
							<line x1="16" y1="17" x2="8" y2="17"/>
							<polyline points="10 9 9 9 8 9"/>
						</svg>
					</button>
					<div class="cc-pill-separator"></div>
					<button type="button" class="cc-pill-icon-btn" data-action="theme" title="Change theme" aria-label="Change theme">
						<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
							<circle cx="12" cy="12" r="10"/>
							<path d="M12 2a10 10 0 0 1 0 20"/>
							<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>
						</svg>
					</button>
				</div>
				<div class="cc-theme-panel" id="cc-theme-panel">
						<div class="cc-theme-panel-label">Theme</div>
						<button class="cc-theme-swatch" data-theme-id="warm-calm">
							<span class="cc-theme-dot" style="background:#b17a57"></span>Warm Calm
						</button>
						<button class="cc-theme-swatch" data-theme-id="fresh-calm">
							<span class="cc-theme-dot" style="background:#6b8f71"></span>Fresh Calm
						</button>
						<button class="cc-theme-swatch" data-theme-id="soft-natural">
							<span class="cc-theme-dot" style="background:#4a90a4"></span>Soft Natural
						</button>
						<button class="cc-theme-swatch" data-theme-id="warm-friendly">
							<span class="cc-theme-dot" style="background:#d9825b"></span>Warm Friendly
						</button>
						<div class="cc-theme-divider"></div>
						<button class="cc-theme-swatch" data-theme-id="warm-calm-dark">
							<span class="cc-theme-dot" style="background:#c08b63"></span>Warm Dark
						</button>
						<button class="cc-theme-swatch" data-theme-id="fresh-calm-dark">
							<span class="cc-theme-dot" style="background:#7fa987"></span>Fresh Dark
						</button>
						<button class="cc-theme-swatch" data-theme-id="soft-natural-dark">
							<span class="cc-theme-dot" style="background:#5fa7bc"></span>Soft Dark
						</button>
						<button class="cc-theme-swatch" data-theme-id="warm-friendly-dark">
							<span class="cc-theme-dot" style="background:#d9825b"></span>Warm Friendly Dark
						</button>
					</div>
			</div>
		`;

		document.documentElement.appendChild(lookupHost);

		const pillContainer = shadowRoot.querySelector(".cc-floating-pill-container");
		const pill = shadowRoot.querySelector(".cc-floating-pill");

		// Prevent mousedown on pill from deselecting text on the host page
		lookupHost.addEventListener("mousedown", (e) => {
			e.stopPropagation();
			e.preventDefault();
		});

		lookupHost.addEventListener("mouseup", (e) => e.stopPropagation());

		const pillWidth = 210;
		const pillHeight = 36;
		const MARGIN   = 10;
		const EDGE_PAD = 16;
		const viewportH = window.innerHeight;
		const viewportW = window.innerWidth;

		const spaceAbove = rect.top;
		const spaceBelow = viewportH - rect.bottom;

		let top;
		let pillAbove;
		if (spaceAbove >= pillHeight + MARGIN) {
			top = rect.top - pillHeight - MARGIN;
			pillAbove = true;
		} else {
			top = rect.bottom + MARGIN;
			pillAbove = false;
		}
		top = Math.max(MARGIN, Math.min(viewportH - pillHeight - EDGE_PAD, top));

		let left = rect.left + (rect.width - pillWidth) / 2;
		left = Math.max(EDGE_PAD, Math.min(viewportW - pillWidth - EDGE_PAD, left));

		pillContainer.style.top  = `${Math.round(top)}px`;
		pillContainer.style.left = `${Math.round(left)}px`;
		pillContainer.dataset.cardDir = pillAbove ? "up" : "down";

		// ── Drag to move ──────────────────────────────────────────────────────
		const dragHandle = shadowRoot.querySelector(".cc-drag-handle");
		let dragState = null;

		function stopDrag() {
			if (!dragState) return;
			dragState = null;
			pillContainer?.classList.remove("cc-dragging");
			lookupHost.dataset.dragging = "0";
			document.getElementById("cc-drag-cursor-web")?.remove();
			document.removeEventListener("mousemove",  onDragMove);
			document.removeEventListener("mouseup",    stopDrag);
			document.removeEventListener("mouseleave", stopDrag);
		}

		function onDragMove(e) {
			if (!dragState) return;
			const dx = e.clientX - dragState.startX;
			const dy = e.clientY - dragState.startY;
			const pillH   = pillContainer.offsetHeight || 40;
			const pillW   = pillContainer.offsetWidth  || 220;
			const TOP_PAD    = 8;
			const BOTTOM_PAD = 80;
			const SIDE_PAD   = 12;
			const newTop  = Math.max(TOP_PAD, Math.min(window.innerHeight - pillH - BOTTOM_PAD, dragState.origTop  + dy));
			const newLeft = Math.max(SIDE_PAD, Math.min(window.innerWidth  - pillW - SIDE_PAD,  dragState.origLeft + dx));
			pillContainer.style.top  = `${Math.round(newTop)}px`;
			pillContainer.style.left = `${Math.round(newLeft)}px`;
		}

		dragHandle.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();

			if (dragState) {
				stopDrag();
				return;
			}

			const cr = pillContainer.getBoundingClientRect();
			dragState = { startX: e.clientX, startY: e.clientY, origTop: cr.top, origLeft: cr.left };
			pillContainer.classList.add("cc-dragging");
			lookupHost.dataset.dragging = "1";

			let cursorStyle = document.getElementById("cc-drag-cursor-web");
			if (!cursorStyle) {
				cursorStyle = document.createElement("style");
				cursorStyle.id = "cc-drag-cursor-web";
				document.head.appendChild(cursorStyle);
			}
			cursorStyle.textContent = "*, *::before, *::after { cursor: grabbing !important; }";

			document.addEventListener("mousemove",  onDragMove);
			document.addEventListener("mouseup",    stopDrag);
			document.addEventListener("mouseleave", stopDrag);
		});

		const explainBtn = shadowRoot.querySelector('[data-action="explain"]');
		const highlightBtn = shadowRoot.querySelector('[data-action="highlight"]');
		const saveBtn = shadowRoot.querySelector('[data-action="save"]');
		const themeBtn = shadowRoot.querySelector('[data-action="theme"]');
		const themePanel = shadowRoot.querySelector("#cc-theme-panel");
		const themeSwatches = shadowRoot.querySelectorAll(".cc-theme-swatch");
		const highlightChevron = shadowRoot.querySelector('[data-action="highlight-mode"]');
		const highlightModePanel = shadowRoot.querySelector("#cc-highlight-mode-panel");
		const highlightModeBtns = shadowRoot.querySelectorAll(".cc-highlight-mode-btn");

		// Fix 5 — use module-level cache; no async race on first click
		let highlightMode = currentHighlightMode;
		highlightModeBtns.forEach(b => { b.dataset.active = String(b.dataset.mode === highlightMode); });

		explainBtn.addEventListener("click", () => {
			const existingCard = shadowRoot.querySelector(".cc-dropdown-card");
			if (existingCard) {
				existingCard.remove();
				return;
			}
			const card = document.createElement("div");
			card.className = "cc-dropdown-card";
			card.innerHTML = `
				<div class="cc-card-body">
					<div class="cc-card-head">
						<span class="cc-card-word">${escapeHtml(selectedText)}</span>
						<button type="button" class="cc-card-close" aria-label="Close">&times;</button>
					</div>
					<div class="cc-card-content"></div>
				</div>
				<div class="cc-card-footer">
					<button type="button" class="cc-card-btn" data-action="pronounce" aria-label="Pronounce word" title="Pronounce">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
							<path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
							<path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
						</svg>
					</button>
					<button type="button" class="cc-card-btn" data-action="card-save" aria-label="Save word" title="Save">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
						</svg>
					</button>
					<button type="button" class="cc-card-btn" data-action="copy" aria-label="Copy definition" title="Copy">
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
							<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
						</svg>
					</button>
				</div>
				<div class="cc-card-toast" data-show="false"></div>
			`;

			card.querySelector(".cc-card-close").addEventListener("click", removeCard);

			// Toast helper
			const toast = card.querySelector(".cc-card-toast");
			function showToast(msg) {
				toast.textContent = msg;
				toast.dataset.show = "true";
				setTimeout(() => { toast.dataset.show = "false"; }, 1400);
			}

			// Pronounce
			card.querySelector('[data-action="pronounce"]').addEventListener("click", () => {
				if ("speechSynthesis" in window) {
					const utter = new SpeechSynthesisUtterance(selectedText);
					utter.rate = 0.9;
					window.speechSynthesis.cancel();
					window.speechSynthesis.speak(utter);
				}
			});

			// Save (card footer)
			const cardSaveBtn = card.querySelector('[data-action="card-save"]');
			cardSaveBtn.addEventListener("click", async () => {
				const isActive = cardSaveBtn.dataset.active === "true";
				cardSaveBtn.dataset.active = isActive ? "false" : "true";
				await saveSelection();
				showToast(isActive ? "Removed" : "Saved");
			});

			// Copy definition
			card.querySelector('[data-action="copy"]').addEventListener("click", async () => {
				const defText = currentDefinition || selectedText;
				try {
					await navigator.clipboard.writeText(defText);
					showToast("Copied");
				} catch {
					showToast("Copy failed");
				}
			});

			pillContainer.appendChild(card);
			explainSelection(card.querySelector(".cc-card-content"));

			// Flip card upward if pill opened above the selection
			if (pillContainer.dataset.cardDir === "up") {
				card.style.marginTop    = "0";
				card.style.marginBottom = "8px";
				card.style.order        = "-1";
				requestAnimationFrame(() => {
					const cardH  = card.offsetHeight;
					const curTop = parseFloat(pillContainer.style.top) || 0;
					const newTop = Math.max(8, curTop - cardH - 8);
					pillContainer.style.top = `${Math.round(newTop)}px`;
				});
			}
		});

		highlightBtn.addEventListener("click", () => {
			if (highlightMode === "pointer") {
				doPointerHighlight();
			} else {
				toggleHighlight();
			}
		});
		saveBtn.addEventListener("click", saveSelection);

		// Highlight mode chevron — open/close picker
		highlightChevron.addEventListener("click", (e) => {
			e.stopPropagation();
			highlightModePanel.classList.toggle("open");
			themePanel.classList.remove("open");
		});

		// Mode selection
		highlightModeBtns.forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				highlightMode = btn.dataset.mode;
				currentHighlightMode = highlightMode;
				chrome.storage.local.set({ contentCoreHighlightMode: highlightMode });
				highlightModeBtns.forEach(b => { b.dataset.active = String(b.dataset.mode === highlightMode); });
				highlightModePanel.classList.remove("open");
				if (highlightMode === "pointer") {
					doPointerHighlight();
				} else {
					toggleHighlight();
				}
			});
		});

		// Close panels when clicking outside
		document.addEventListener("mousedown", () => {
			highlightModePanel.classList.remove("open");
		}, { capture: true });

		// Mark the active swatch on open
		function refreshSwatches() {
			themeSwatches.forEach((s) => {
				s.dataset.active = String(s.dataset.themeId === currentTheme);
			});
		}

		// Toggle panel open/close
		themeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			const isOpen = themePanel.classList.toggle("open");
			if (isOpen) refreshSwatches();
		});

		// Hover — preview theme temporarily
		themeSwatches.forEach((swatch) => {
			swatch.addEventListener("mouseenter", () => {
				lookupHost.setAttribute("data-theme", swatch.dataset.themeId);
			});
			swatch.addEventListener("mouseleave", () => {
				lookupHost.setAttribute("data-theme", currentTheme);
			});

			// Click — commit theme permanently
			swatch.addEventListener("click", (e) => {
				e.stopPropagation();
				const chosen = swatch.dataset.themeId;
				currentTheme = chosen;
				lookupHost.setAttribute("data-theme", currentTheme);
				chrome.storage.local.set({ contentCoreTheme: currentTheme });
				refreshSwatches();
				themePanel.classList.remove("open");
			});
		});

		// Close panel when clicking outside
		document.addEventListener("mousedown", () => {
			themePanel.classList.remove("open");
		}, { capture: true });
	}

	function showSelectionCard() {
		const selection = window.getSelection();
		selectedText = clean(selection?.toString() || "");

		if (!selectedText || selectedText.length > 160 || !selection.rangeCount) return;

		try {
			const range = selection.getRangeAt(0);
			const rect = range.getBoundingClientRect();
			if (rect.width > 0 || rect.height > 0) {
				savedRange = range.cloneRange();
				createCard(rect, getContext(selection));
			}
		} catch (e) {
			console.error("Selection error:", e);
		}
	}

	// Inject subtle page-level CSS for the temporary highlight mark only
	function injectPageHighlightStyles() {
		if (document.getElementById("cc-web-highlight-style")) return;
		const style = document.createElement("style");
		style.id = "cc-web-highlight-style";
		style.textContent = `
			mark.cc-web-highlight {
				background-color: rgba(255, 235, 59, 0.45) !important;
				color: inherit !important;
				border-radius: 2px;
				cursor: pointer;
				box-decoration-break: clone;
				-webkit-box-decoration-break: clone;
				padding: 1px 0;
				position: relative;
			}

			/* Fix 1 — pointer-only marks have no yellow background */
			mark.cc-web-highlight.cc-pointer-only {
				background-color: transparent !important;
			}

			/* Fix 6 — position: absolute matches the inline style set in showPointerHighlight */
			.cc-pointer-highlight-overlay {
				position: absolute;
				pointer-events: none;
				z-index: 2147483646;
			}

			/* Animated border — draws itself left to right then stays */
			.cc-pointer-border {
				position: absolute;
				inset: -3px;
				border-radius: 3px;
				border: 2px solid currentColor;
				opacity: 0;
				clip-path: inset(0 100% 0 0);
				animation: ccBorderDraw 0.8s cubic-bezier(0.4, 0, 0.2, 1) forwards;
			}

			@keyframes ccBorderDraw {
				0%   { clip-path: inset(0 100% 0 0); opacity: 1; }
				100% { clip-path: inset(0 0% 0 0);   opacity: 1; }
			}

			/* Pointer cursor — slides in from off-screen to bottom-right and stays */
			.cc-pointer-cursor {
				position: absolute;
				width: 18px;
				height: 18px;
				transform: rotate(-90deg);
				opacity: 0;
				transform-origin: center center;
				animation: ccPointerSlide 0.8s cubic-bezier(0.4, 0, 0.2, 1) 0.3s forwards;
			}

			@keyframes ccPointerSlide {
				0%   { opacity: 0; translate: -10px -10px; }
				60%  { opacity: 1; translate: 2px 2px; }
				100% { opacity: 1; translate: 0px 0px; }
			}
		`;
		(document.head || document.documentElement).appendChild(style);
	}

	// Fix 3 — remove all tracked pointer overlays and clear the array
	function removePointerOverlay() {
		pointerOverlays.forEach((el) => el.remove());
		pointerOverlays = [];
	}

	// Resolve the accent color for the current theme
	function getThemeAccent() {
		const map = {
			"warm-calm":          "#b17a57",
			"fresh-calm":         "#6b8f71",
			"soft-natural":       "#4a90a4",
			"warm-friendly":      "#d9825b",
			"warm-calm-dark":     "#c08b63",
			"fresh-calm-dark":    "#7fa987",
			"soft-natural-dark":  "#5fa7bc",
			"warm-friendly-dark": "#d9825b",
		};
		return map[currentTheme] || "#4b4fd1";
	}

	// Fix 3+4 — create an overlay for each mark element and track them all
	function showPointerHighlight(markEl) {
		// Remove previous overlays before creating new ones
		removePointerOverlay();

		const rect = markEl.getBoundingClientRect();
		if (!rect.width || !rect.height) return;

		const accent = getThemeAccent();

		const overlay = document.createElement("div");
		overlay.className = "cc-pointer-highlight-overlay";
		overlay.style.cssText = `
			left: ${rect.left + window.scrollX}px;
			top: ${rect.top + window.scrollY}px;
			width: ${rect.width}px;
			height: ${rect.height}px;
		`;

		const border = document.createElement("div");
		border.className = "cc-pointer-border";
		border.style.borderColor = accent;

		const pointer = document.createElement("div");
		pointer.className = "cc-pointer-cursor";
		pointer.style.cssText = `
			left: ${rect.width + 4}px;
			top: ${rect.height + 4}px;
			color: ${accent};
		`;
		pointer.innerHTML = `<svg stroke="currentColor" fill="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 16 16" height="100%" width="100%" xmlns="http://www.w3.org/2000/svg"><path d="M14.082 2.182a.5.5 0 0 1 .103.557L8.528 15.467a.5.5 0 0 1-.917-.007L5.57 10.694.803 8.652a.5.5 0 0 1-.006-.916l12.728-5.657a.5.5 0 0 1 .556.103z"></path></svg>`;

		overlay.appendChild(border);
		overlay.appendChild(pointer);
		document.documentElement.appendChild(overlay);
		// Fix 3 — track for later cleanup
		pointerOverlays.push(overlay);
	}

	injectPageHighlightStyles();

	document.addEventListener("mouseup", (e) => {
		if (lookupHost && (e.target === lookupHost || lookupHost.contains(e.target))) return;
		// Don't trigger if a drag is in progress
		if (lookupHost?.dataset.dragging === "1") return;
		clearTimeout(selectionTimer);
		selectionTimer = setTimeout(showSelectionCard, 80);
	});

	document.addEventListener("mousedown", (e) => {
		if (!lookupHost) return;
		// Don't dismiss while dragging
		if (lookupHost.dataset.dragging === "1") return;
		// Use composedPath to correctly detect clicks inside shadow DOM
		const path = e.composedPath();
		const insidePill = path.some(node => node === lookupHost);
		if (!insidePill) {
			removeCard();
		}
	});

	// Removed: document.addEventListener("scroll", removeCard) — popup stays open on scroll

	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape") removeCard();
	});

	// Theme: read preference once, apply live to any open card, and keep it
	// current for the next card that opens.
	chrome.storage.local.get({ contentCoreTheme: "warm-calm" }, ({ contentCoreTheme }) => {
		currentTheme = contentCoreTheme;
		lookupHost?.setAttribute("data-theme", currentTheme);
	});

	// Fix 5 — seed highlight mode cache at startup
	chrome.storage.local.get({ contentCoreHighlightMode: "traditional" }, ({ contentCoreHighlightMode }) => {
		currentHighlightMode = contentCoreHighlightMode;
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area === "local" && changes.contentCoreTheme) {
			currentTheme = changes.contentCoreTheme.newValue;
			lookupHost?.setAttribute("data-theme", currentTheme);
		}
		// Fix 5 — keep highlight mode cache in sync
		if (area === "local" && changes.contentCoreHighlightMode) {
			currentHighlightMode = changes.contentCoreHighlightMode.newValue;
		}
	});
})();
