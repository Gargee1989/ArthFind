(() => {
	"use strict";

	// DOM Elements - Toolbar & Main
	const fileInput = document.querySelector("#file-input");
	const renderTarget = document.querySelector("#pdf-render");
	const emptyState = document.querySelector("#empty-state");
	const docTitle = document.querySelector("#doc-title");
	const toast = document.querySelector("#cc-toast");

	// Page Navigation Controls
	const pagePrev = document.querySelector("#page-prev");
	const pageNext = document.querySelector("#page-next");
	const pageNumInput = document.querySelector("#page-num-input");
	const pageCountDisplay = document.querySelector("#page-count-display");

	// Search / Find Controls
	const findInput = document.querySelector("#find-input");
	const findBtn = document.querySelector("#find-btn");
	const findPrev = document.querySelector("#find-prev");
	const findNext = document.querySelector("#find-next");
	const findCount = document.querySelector("#find-count");

	// Zoom & Fit Controls
	const zoomOut = document.querySelector("#zoom-out");
	const zoomIn = document.querySelector("#zoom-in");
	const zoomBadge = document.querySelector("#zoom-badge");
	const fitToggleBtn = document.querySelector("#fit-toggle-btn");

	// State
	const ZOOM_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
	let currentScale = 1.0;
	let isFitWidth = false;
	let pdfDoc = null;
	let pdfRawData = null;
	let currentDocument = "";
	let totalPages = 0;
	let currentPage = 1;
	let pageText = "";

	// Render Lock & Abort Controller State
	let isRendering = false;
	let renderAbortController = null;

	// Scroll Tracking & Lock State
	let isProgrammaticScroll = false;
	let scrollRafId = null;
	let scrollLockTimeout = null;

	// Selection & Floating Toolbar State
	let selectedText = "";
	let selectionData = null;
	let currentDefinition = "";
	let currentTone = "";
	let currentSynonym = "";
	let floatingPillContainer = null;
	let pillRemovalTimer = null;
	let savedRange = null;
	// Text offsets stay stable when PDF.js rebuilds the text layer at another zoom.
	let pdfHighlights = [];
	let currentPdfFingerprint = "";

	const HIGHLIGHT_STORAGE_KEY = "contentCorePdfHighlightsByFingerprint";
	const MAX_PDF_HIGHLIGHT_DOCS = 40;
	const HIGHLIGHT_COLORS = Object.freeze({
		yellow: { fill: "rgba(255, 218, 64, 0.58)", shadow: "rgba(161, 98, 7, 0.45)" },
		green: { fill: "rgba(134, 239, 172, 0.56)", shadow: "rgba(22, 101, 52, 0.34)" },
		blue: { fill: "rgba(147, 197, 253, 0.58)", shadow: "rgba(30, 64, 175, 0.35)" },
		pink: { fill: "rgba(244, 171, 198, 0.56)", shadow: "rgba(157, 23, 77, 0.33)" },
		orange: { fill: "rgba(253, 186, 116, 0.56)", shadow: "rgba(154, 52, 18, 0.34)" }
	});
	let currentHighlightColor = "yellow";

	// In-PDF Search State
	let findMatches = [];
	let activeFindIndex = -1;

	const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
	const normalizeHighlightColor = (value) =>
		Object.prototype.hasOwnProperty.call(HIGHLIGHT_COLORS, value) ? value : "yellow";

	function applyHighlightAppearance(mark, colorId) {
		const color = HIGHLIGHT_COLORS[normalizeHighlightColor(colorId)];
		mark.dataset.highlightColor = normalizeHighlightColor(colorId);
		mark.style.setProperty("--cc-highlight-fill", color.fill);
		mark.style.setProperty("--cc-highlight-shadow", color.shadow);
	}

	function sanitizePdfHighlightEntry(highlight) {
		const page = String(highlight?.page ?? "");
		const item = String(highlight?.item ?? "");
		const start = Number(highlight?.start);
		const end = Number(highlight?.end);
		const mode = highlight?.mode === "pointer" ? "pointer" : "traditional";
		const color = normalizeHighlightColor(highlight?.color);
		if (!page || !item || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
		return { page, item, start, end, mode, color };
	}

	function getStoredHighlightRecords(rawValue) {
		return rawValue && typeof rawValue === "object" && !Array.isArray(rawValue) ? rawValue : {};
	}

	// Theme module — applies contentCoreTheme to html[data-theme]
	let _lastAppliedTheme = null;
	let themeCommitVersion = 0;
	function applyTheme(themeId) {
		const id = themeId || "warm-calm";
		_lastAppliedTheme = id;
		document.documentElement.dataset.theme = id;
	}

	const themeReadVersion = themeCommitVersion;
	chrome.storage.local.get({ contentCoreTheme: "warm-calm" }, ({ contentCoreTheme }) => {
		if (themeReadVersion !== themeCommitVersion) return;
		applyTheme(contentCoreTheme);
	});
	chrome.storage.local.get({ contentCoreHighlightColor: "yellow" }, ({ contentCoreHighlightColor }) => {
		currentHighlightColor = normalizeHighlightColor(contentCoreHighlightColor);
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		if (changes.contentCoreTheme) {
			applyTheme(changes.contentCoreTheme.newValue);
			refreshTbSwatches();
		}
		if (changes.contentCoreHighlightColor?.newValue) {
			currentHighlightColor = normalizeHighlightColor(changes.contentCoreHighlightColor.newValue);
		}
	});

	// Toolbar theme picker
	const tbThemeBtn = document.querySelector("#tb-theme-btn");
	const tbThemePanel = document.querySelector("#tb-theme-panel");
	const tbThemeSwatches = document.querySelectorAll(".tb-theme-swatch");

	function refreshTbSwatches() {
		const current = _lastAppliedTheme || "warm-calm";
		tbThemeSwatches.forEach((s) => {
			s.dataset.active = String(s.dataset.themeId === current);
		});
		tbThemeBtn?.classList.toggle("active", tbThemePanel?.classList.contains("open"));
	}

	tbThemeBtn?.addEventListener("click", (e) => {
		e.stopPropagation();
		const isOpen = tbThemePanel.classList.toggle("open");
		tbThemeBtn.classList.toggle("active", isOpen);
		if (isOpen) refreshTbSwatches();
	});

	// Theme changes are committed by selection, never by pointer enter/leave.
	tbThemeSwatches.forEach((swatch) => {

		// Click — commit permanently
		swatch.addEventListener("click", (e) => {
			e.stopPropagation();
			const chosen = swatch.dataset.themeId;
			themeCommitVersion += 1;
			applyTheme(chosen);
			chrome.storage.local.set({ contentCoreTheme: chosen });
			refreshTbSwatches();
			tbThemePanel.classList.remove("open");
			tbThemeBtn.classList.remove("active");
		});
	});

	document.addEventListener("mousedown", (e) => {
		if (tbThemePanel && !tbThemeBtn.contains(e.target) && !tbThemePanel.contains(e.target)) {
			tbThemePanel.classList.remove("open");
			tbThemeBtn.classList.remove("active");
		}
	});

	// Toolbar background image picker
	const tbBgSwatches = document.querySelectorAll(".tb-bg-swatch");
	const tbBgCustomGrid = document.getElementById("tb-bg-custom-grid");
	const tbBgUploadBtn = document.getElementById("tb-bg-upload-btn");
	const tbBgFileInput = document.getElementById("tb-bg-file-input");
	const tbBgUploadError = document.getElementById("tb-bg-upload-error");
	const MAX_CUSTOM_BGS = 2;
	let currentBg = "none";
	// Array of { id: string, dataUrl: string }
	let customBgImages = [];

	function showBgUploadError(msg) {
		if (!tbBgUploadError) return;
		tbBgUploadError.textContent = msg;
		tbBgUploadError.classList.add("visible");
	}

	function clearBgUploadError() {
		if (!tbBgUploadError) return;
		tbBgUploadError.textContent = "";
		tbBgUploadError.classList.remove("visible");
	}

	function getCustomDataUrl(bgValue) {
		if (!bgValue || !bgValue.startsWith("custom-")) return null;
		const id = bgValue.slice(7); // strip "custom-"
		const entry = customBgImages.find((c) => c.id === id);
		return entry ? entry.dataUrl : null;
	}

	function applyBg(bgValue) {
		currentBg = bgValue || "none";
		if (currentBg === "none") {
			document.body.style.backgroundImage = "";
			document.body.classList.remove("has-bg-image");
			renderTarget.classList.remove("has-bg-image");
		} else if (currentBg.startsWith("custom-")) {
			const dataUrl = getCustomDataUrl(currentBg);
			if (dataUrl) {
				document.body.style.backgroundImage = `url('${dataUrl}')`;
				document.body.classList.add("has-bg-image");
				renderTarget.classList.remove("has-bg-image");
			}
		} else {
			// Built-in bundled backgrounds
			const url = `url('${chrome.runtime.getURL(currentBg)}')`;
			document.body.style.backgroundImage = url;
			document.body.classList.add("has-bg-image");
			renderTarget.classList.remove("has-bg-image");
		}
		// Sync active state on all swatches (built-in + custom)
		document.querySelectorAll(".tb-bg-swatch").forEach((s) => {
			s.dataset.active = String(s.dataset.bg === currentBg);
		});
	}

	function saveCustomImages() {
		chrome.storage.local.set({ contentCoreBgCustomImages: customBgImages });
	}

	function renderCustomSwatches() {
		if (!tbBgCustomGrid) return;
		tbBgCustomGrid.innerHTML = "";
		customBgImages.forEach(({ id, dataUrl }) => {
			const bgKey = `custom-${id}`;
			const wrapper = document.createElement("div");
			wrapper.className = "tb-bg-swatch-wrapper";

			const btn = document.createElement("button");
			btn.className = "tb-bg-swatch";
			btn.dataset.bg = bgKey;
			btn.dataset.active = String(bgKey === currentBg);
			btn.title = "Your custom background";
			btn.style.backgroundImage = `url('${dataUrl}')`;
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				clearBgUploadError();
				chrome.storage.local.set({ contentCoreBg: bgKey });
				applyBg(bgKey);
			});

			const delBtn = document.createElement("button");
			delBtn.className = "tb-bg-swatch-delete";
			delBtn.title = "Remove this background";
			delBtn.setAttribute("aria-label", "Remove custom background");
			delBtn.textContent = "✕";
			delBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				clearBgUploadError();
				// If this was the active bg, reset to none
				if (currentBg === bgKey) {
					chrome.storage.local.set({ contentCoreBg: "none" });
					applyBg("none");
				}
				customBgImages = customBgImages.filter((c) => c.id !== id);
				saveCustomImages();
				renderCustomSwatches();
				syncUploadBtnState();
			});

			wrapper.appendChild(btn);
			wrapper.appendChild(delBtn);
			tbBgCustomGrid.appendChild(wrapper);
		});
	}

	function syncUploadBtnState() {
		if (!tbBgUploadBtn) return;
		const atLimit = customBgImages.length >= MAX_CUSTOM_BGS;
		tbBgUploadBtn.disabled = atLimit;
		tbBgUploadBtn.title = atLimit
			? `Limit of ${MAX_CUSTOM_BGS} custom backgrounds reached. Remove one to add more.`
			: "Upload a custom background (at least 1920×1080 px)";
	}

	// Set correct full extension URLs on the built-in thumbnail swatches
	tbBgSwatches.forEach((swatch) => {
		const bg = swatch.dataset.bg;
		if (bg && bg !== "none") {
			swatch.style.backgroundImage = `url('${chrome.runtime.getURL(bg)}')`;
		}
	});

	// Restore saved backgrounds on load
	chrome.storage.local.get(
		{ contentCoreBg: "none", contentCoreBgCustomImages: [] },
		({ contentCoreBg, contentCoreBgCustomImages }) => {
			customBgImages = Array.isArray(contentCoreBgCustomImages) ? contentCoreBgCustomImages : [];
			renderCustomSwatches();
			syncUploadBtnState();
			applyBg(contentCoreBg);
		}
	);

	// Click handlers for built-in swatches
	tbBgSwatches.forEach((swatch) => {
		swatch.addEventListener("click", (e) => {
			e.stopPropagation();
			clearBgUploadError();
			const chosen = swatch.dataset.bg;
			chrome.storage.local.set({ contentCoreBg: chosen });
			applyBg(chosen);
		});
	});

	// Upload button triggers file input
	if (tbBgUploadBtn && tbBgFileInput) {
		tbBgUploadBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			if (tbBgUploadBtn.disabled) return;
			clearBgUploadError();
			tbBgFileInput.value = "";
			tbBgFileInput.click();
		});

		tbBgFileInput.addEventListener("change", () => {
			const file = tbBgFileInput.files && tbBgFileInput.files[0];
			if (!file) return;

			if (customBgImages.length >= MAX_CUSTOM_BGS) {
				showBgUploadError(`You've reached the limit of ${MAX_CUSTOM_BGS} custom backgrounds. Remove one first.`);
				return;
			}

			// Only accept image files
			if (!file.type.startsWith("image/")) {
				showBgUploadError("Please select an image file.");
				return;
			}

			const reader = new FileReader();
			reader.onload = (evt) => {
				const dataUrl = evt.target.result;
				// Validate resolution: must be at least 1920×1080
				const img = new Image();
				img.onload = () => {
					if (img.naturalWidth < 1920 || img.naturalHeight < 1080) {
						showBgUploadError(`Image must be at least 1920×1080 px. Yours is ${img.naturalWidth}×${img.naturalHeight}.`);
						return;
					}
					clearBgUploadError();
					const newId = Date.now().toString(36);
					customBgImages.push({ id: newId, dataUrl });
					saveCustomImages();
					renderCustomSwatches();
					syncUploadBtnState();
					const bgKey = `custom-${newId}`;
					chrome.storage.local.set({ contentCoreBg: bgKey });
					applyBg(bgKey);
				};
				img.onerror = () => {
					showBgUploadError("Could not read the image. Please try a different file.");
				};
				img.src = dataUrl;
			};
			reader.onerror = () => {
				showBgUploadError("Failed to read the file. Please try again.");
			};
			reader.readAsDataURL(file);
		});
	}

	// Toast Helper
	let toastTimer = null;
	function showToast(message) {
		if (!toast) return;
		toast.textContent = message;
		toast.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			toast.classList.remove("show");
		}, 1800);
	}

	// Context Extraction
	function contextFor(selection, sourceText = pageText) {
		const selected = clean(selection ? selection.toString() : "");
		const cleanSource = clean(sourceText);
		if (!selected) return "";
		const index = cleanSource.toLowerCase().indexOf(selected.toLowerCase());
		// PDF text can differ from the browser selection. Do not substitute an
		// unrelated passage from the start of the page when matching fails.
		if (index < 0) return selected;

		const selectionEnd = index + selected.length;
		const sentences = Array.from(new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(cleanSource));
		const first = sentences.findIndex(part => part.index + part.segment.length > index);
		const last = sentences.findIndex(part => part.index + part.segment.length >= selectionEnd);
		let start = sentences[Math.max(0, first - 1)].index;
		const next = sentences[Math.min(sentences.length - 1, last + 1)];
		let end = next.index + next.segment.length;

		// Include one sentence on either side, but bound long sentences and
		// punctuation-free pages around the selection instead of the page start.
		const maxLength = Math.max(1200, selected.length);
		if (end - start > maxLength) {
			start = Math.max(start, index - Math.floor((maxLength - selected.length) / 2));
			end = Math.min(end, start + maxLength);
		}
		const baseContext = cleanSource.slice(start, end).trim();

		const firstLine = clean(sourceText.split(/\r?\n/)[0] || "");
		let heading = "";
		if (firstLine && firstLine.length <= 100 && !/[.!?]$/.test(firstLine)) {
			heading = firstLine;
		}

		const result = heading ? `[Heading: ${heading}] ${baseContext}` : baseContext;
		return result;
	}

	// Remove Floating Pill & Dropdown
	function removeFloatingPill() {
		clearTimeout(pillRemovalTimer);
		pillRemovalTimer = null;
		floatingPillContainer?.remove();
		floatingPillContainer = null;
		savedRange = null;
	}

	// Clip the selection to PDF text runs; never mutate the live selection while
	// discovering its boundaries. Element endpoints and backwards selections work too.
	function selectedPdfSegments(range) {
		if (!range || range.collapsed) return [];
		const segments = [];
		for (const span of renderTarget.querySelectorAll(".text-layer [data-text-index]")) {
			if (!range.intersectsNode(span)) continue;
			const clipped = document.createRange();
			clipped.selectNodeContents(span);
			if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0) {
				clipped.setStart(range.startContainer, range.startOffset);
			}
			if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0) {
				clipped.setEnd(range.endContainer, range.endOffset);
			}
			if (clipped.collapsed || !clipped.toString().trim()) continue;
			const prefix = document.createRange();
			prefix.selectNodeContents(span);
			prefix.setEnd(clipped.startContainer, clipped.startOffset);
			const start = prefix.toString().length;
			segments.push({ span, page: span.closest(".pdf-page").dataset.pageNumber,
				item: span.dataset.textIndex, start, end: start + clipped.toString().length });
		}
		return segments;
	}

	function sameTextRun(a, b) {
		return a.page === b.page && a.item === b.item;
	}

	function segmentIsHighlighted(segment) {
		let end = segment.start;
		for (const mark of pdfHighlights.filter(h => sameTextRun(h, segment)).sort((a, b) => a.start - b.start)) {
			if (mark.start > end) break;
			if (mark.end > end) end = mark.end;
			if (end >= segment.end) return true;
		}
		return false;
	}

	function isRangeHighlighted(range) {
		const segments = selectedPdfSegments(range);
		return segments.length > 0 && segments.every(segmentIsHighlighted);
	}

	function unwrapHighlight(mark) {
		const parent = mark.parentNode;
		if (!parent) return;
		mark.replaceWith(...mark.childNodes);
		parent.normalize();
	}

	// Snapshot text-node ranges before wrapping, then edit from end to start.
	// Search marks can remain nested inside the original PDF.js text run.
	function textRanges(span, start, end) {
		const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
		const ranges = [];
		let offset = 0;
		while (walker.nextNode()) {
			const node = walker.currentNode;
			const from = Math.max(0, start - offset);
			const to = Math.min(node.length, end - offset);
			if (to > from) {
				const range = document.createRange();
				range.setStart(node, from);
				range.setEnd(node, to);
				ranges.push(range);
			}
			offset += node.length;
			if (offset >= end) break;
		}
		return ranges;
	}

	function restorePdfHighlights(root = renderTarget) {
		root.querySelectorAll(".cc-pdf-highlight").forEach(unwrapHighlight);
		for (const span of root.querySelectorAll(".text-layer [data-text-index]")) {
			const run = { page: span.closest(".pdf-page").dataset.pageNumber, item: span.dataset.textIndex };
			for (const highlight of pdfHighlights.filter(h => sameTextRun(h, run))) {
				for (const range of textRanges(span, highlight.start, highlight.end).reverse()) {
					const mark = document.createElement("mark");
					mark.className = "cc-pdf-highlight" + (highlight.mode === "pointer" ? " cc-pointer-only" : "");
					applyHighlightAppearance(mark, highlight.color);
					range.surroundContents(mark);
				}
			}
		}
	}

	async function computePdfFingerprint(arrayBuffer) {
		try {
			if (!globalThis.crypto?.subtle) {
				console.warn("[arth.find] crypto.subtle unavailable, using fallback fingerprint.");
				return `fallback:${currentDocument}:${arrayBuffer.byteLength}`;
			}
			const digest = await globalThis.crypto.subtle.digest("SHA-256", arrayBuffer);
			const hashBytes = new Uint8Array(digest);
			return Array.from(hashBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
		} catch (error) {
			console.warn("[arth.find] Failed to compute PDF fingerprint:", error);
			return `fallback:${currentDocument}:${arrayBuffer.byteLength}`;
		}
	}

	async function loadStoredHighlightsForCurrentPdf() {
		if (!currentPdfFingerprint) {
			pdfHighlights = [];
			return;
		}
		try {
			const stored = await chrome.storage.local.get({ [HIGHLIGHT_STORAGE_KEY]: {} });
			const records = getStoredHighlightRecords(stored[HIGHLIGHT_STORAGE_KEY]);
			const highlights = records[currentPdfFingerprint]?.highlights;
			pdfHighlights = Array.isArray(highlights)
				? highlights.map(sanitizePdfHighlightEntry).filter(Boolean)
				: [];
		} catch (error) {
			console.warn("[arth.find] Failed to load PDF highlights:", error);
			pdfHighlights = [];
		}
	}

	async function persistHighlightsForCurrentPdf() {
		if (!currentPdfFingerprint) return;
		try {
			const stored = await chrome.storage.local.get({ [HIGHLIGHT_STORAGE_KEY]: {} });
			const records = getStoredHighlightRecords(stored[HIGHLIGHT_STORAGE_KEY]);
			if (!pdfHighlights.length) {
				delete records[currentPdfFingerprint];
			} else {
				records[currentPdfFingerprint] = {
					name: currentDocument,
					updatedAt: Date.now(),
					highlights: pdfHighlights.map(sanitizePdfHighlightEntry).filter(Boolean)
				};
			}
			const trimmed = Object.fromEntries(
				Object.entries(records)
					.sort(([, a], [, b]) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))
					.slice(0, MAX_PDF_HIGHLIGHT_DOCS)
			);
			await chrome.storage.local.set({ [HIGHLIGHT_STORAGE_KEY]: trimmed });
		} catch (error) {
			console.warn("[arth.find] Failed to persist PDF highlights:", error);
		}
	}

	function refreshPointerHighlights() {
		showPointerHighlight([...renderTarget.querySelectorAll(".cc-pointer-only")]);
	}

	async function toggleHighlight(mode = "traditional") {
		const selection = window.getSelection();
		const range = savedRange || (selection?.rangeCount ? selection.getRangeAt(0) : null);
		const segments = selectedPdfSegments(range);
		if (!segments.length) return;
		const remove = segments.every(segmentIsHighlighted);
		for (const segment of segments) {
			// Preserve unselected portions of an existing highlight.
			pdfHighlights = pdfHighlights.flatMap(h => {
				if (!sameTextRun(h, segment) || h.end <= segment.start || h.start >= segment.end) return [h];
				const remaining = [];
				if (h.start < segment.start) remaining.push({ ...h, end: segment.start });
				if (h.end > segment.end) remaining.push({ ...h, start: segment.end });
				return remaining;
			});
			if (!remove) {
				const { span, ...offsets } = segment;
				pdfHighlights.push({ ...offsets, mode, color: currentHighlightColor });
			}
		}
		selection?.removeAllRanges();
		savedRange = null;
		restorePdfHighlights();
		refreshPointerHighlights();
		await persistHighlightsForCurrentPdf();
		floatingPillContainer?.querySelector('[data-action="highlight"]')?.classList.toggle("active", !remove);
		showToast(remove ? "Highlight removed" : "Highlighted");
		clearTimeout(pillRemovalTimer);
		pillRemovalTimer = setTimeout(removeFloatingPill, 400);
	}

	// Save to chrome.storage.local
	async function saveWord() {
		if (!selectionData || !selectionData.word) return;
		try {
			const stored = await chrome.storage.local.get("contentCoreSavedWords");
			const saved = Array.isArray(stored.contentCoreSavedWords) ? stored.contentCoreSavedWords : [];
			const docName = currentDocument || "Document.pdf";
			const existingIndex = saved.findIndex(
				(item) => item.word === selectionData.word && item.document === docName
			);

			const wordItem = {
				word: selectionData.word,
				context: selectionData.context,
				definition: currentDefinition || "",
				document: docName,
				savedAt: Date.now()
			};

			if (existingIndex >= 0) {
				saved[existingIndex] = wordItem;
			} else {
				saved.unshift(wordItem);
			}

			await chrome.storage.local.set({ contentCoreSavedWords: saved.slice(0, 100) });

			// Animate Save Icon in Pill
			const saveBtn = floatingPillContainer?.querySelector('[data-action="save"]');
			if (saveBtn) {
				saveBtn.classList.add("saved-success");
				saveBtn.innerHTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
			}

			showToast("Saved to vocabulary");
		} catch (error) {
			console.error("[arth.find] Save error:", error);
			showToast("Could not save word");
		}
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
						<span class="cc-meta-badge">In short:</span>
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

	// Explain This - Call /define API
	async function explainWord(cardContent) {
		const requestedSelection = selectionData;
		const isCurrent = () => cardContent.isConnected && selectionData === requestedSelection;
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
				word: requestedSelection.word,
				target: requestedSelection.word,
				context: requestedSelection.context,
				credential_id: settings.contentCoreCredentialId,
				credential_token: settings.contentCoreCredentialToken
			};

			let response;
			try {
				response = await fetch(endpoint, {
					method: "POST",
					headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
					body: JSON.stringify(payload)
				});
			} catch (networkError) {
				if (!isCurrent()) return;
				if (typeof navigator !== "undefined" && navigator.onLine === false) {
					renderCardError(cardContent, "No Internet Connection", "Your device appears to be offline. Please check your network and try again.");
				} else {
					renderCardError(cardContent, "Connection Failed", "Could not connect to the Arth.Find backend. Please ensure the backend server is running on port 8000.");
				}
				return;
			}

			if (!isCurrent()) {
				await response.body?.cancel();
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
						errTitle = (lower.includes("key") || lower.includes("credential") || lower.includes("auth") || lower.includes("token")) ? "Invalid API Key" : "Invalid Request";
						errDesc = message || "Please check your settings or selected text.";
					} else if (response.status === 429) { errTitle = "Rate Limit Exceeded"; errDesc = message || "Too many requests. Please wait a moment before trying again."; }
					else if (response.status === 504) { errTitle = "Request Timed Out"; errDesc = message || "The AI provider took too long to respond. Please try again."; }
					else if (response.status === 503) { errTitle = "Service Unavailable"; errDesc = message || "The definition service is temporarily unavailable. Please try again later."; }
					else { errDesc = message || errDesc; }
				} catch {
					if (response.status === 429) { errTitle = "Rate Limit Exceeded"; errDesc = "Too many requests. Please wait a moment before trying again."; }
					else if (response.status === 504) { errTitle = "Request Timed Out"; errDesc = "The AI provider took too long to respond. Please try again."; }
					else if (response.status === 503) { errTitle = "Service Unavailable"; errDesc = "The definition service is temporarily unavailable. Please try again later."; }
				}
				renderCardError(cardContent, errTitle, errDesc);
				return;
			}

			const result = await ContentCoreDefinition.read(response, (meaning) => {
                if (isCurrent()) renderCardDefinition(cardContent, clean(meaning), "", "");
            });
            if (!isCurrent()) return;
			const meaning = clean(String(result.meaning || result.definition || result.explanation || result.answer || ""));

			if (!meaning || meaning === "No definition") {
				renderCardError(cardContent, "No Definition", "The AI provider did not return an explanation for this selection.");
				return;
			}

			currentDefinition = meaning;
			currentTone = clean(String(result.tone || ""));
			currentSynonym = clean(String(result.synonym || ""));
			renderCardDefinition(cardContent, currentDefinition, currentTone, currentSynonym);
		} catch (error) {
			if (!isCurrent()) return;
			renderCardError(cardContent, "Error", error.message || "Definition service unavailable.");
		}
	}

	function escapeHtml(text) {
		const div = document.createElement("div");
		div.textContent = text || "";
		return div.innerHTML;
	}

	function doPointerHighlight() {
		void toggleHighlight("pointer");
	}

	// Pointer highlight animation — one overlay per mark, all persist until next call
	function showPointerHighlight(marks) {
		// Remove previous overlays
		document.querySelectorAll(".cc-pointer-highlight-overlay").forEach((el) => el.remove());

		// Read accent from the live CSS variable (set by applyTheme), fall back to map
		const accentMap = {
			"warm-calm":          "#b17a57",
			"fresh-calm":         "#6b8f71",
			"soft-natural":       "#4a90a4",
			"warm-friendly":      "#d9825b",
			"warm-calm-dark":     "#c08b63",
			"fresh-calm-dark":    "#7fa987",
			"soft-natural-dark":  "#5fa7bc",
			"warm-friendly-dark": "#d9825b",
		};

		const cssAccent = getComputedStyle(document.documentElement).getPropertyValue("--cc-accent").trim();
		const currentThemeId = document.documentElement.dataset.theme || "warm-calm";
		const accent = cssAccent || accentMap[currentThemeId] || "#4a90a4";

		for (const markEl of Array.isArray(marks) ? marks : [marks]) {
			const rect = markEl.getBoundingClientRect();
			const page = markEl.closest(".pdf-page");
			if (!page) continue;
			const containerRect = page.getBoundingClientRect();
			if (!rect.width || !rect.height) continue;

			const overlay = document.createElement("div");
			overlay.className = "cc-pointer-highlight-overlay";
			overlay.style.cssText = `
				position: absolute;
				pointer-events: none;
				z-index: 999;
				left: ${rect.left - containerRect.left}px;
				top: ${rect.top - containerRect.top}px;
				width: ${rect.width}px;
				height: ${rect.height}px;
			`;

			const border = document.createElement("div");
			border.className = "cc-pointer-border";
			border.style.borderColor = accent;

			const pointer = document.createElement("div");
			pointer.className = "cc-pointer-cursor";
			pointer.style.cssText = `left: ${rect.width + 4}px; top: ${rect.height + 4}px; color: ${accent};`;
			pointer.innerHTML = `<svg stroke="currentColor" fill="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 16 16" height="100%" width="100%" xmlns="http://www.w3.org/2000/svg"><path d="M14.082 2.182a.5.5 0 0 1 .103.557L8.528 15.467a.5.5 0 0 1-.917-.007L5.57 10.694.803 8.652a.5.5 0 0 1-.006-.916l12.728-5.657a.5.5 0 0 1 .556.103z"></path></svg>`;

			overlay.appendChild(border);
			overlay.appendChild(pointer);

			page.appendChild(overlay);
		}
	}

	// Show Compact Floating Selection Toolbar
	function showFloatingPill() {
		const selection = window.getSelection();
		selectedText = clean(selection?.toString() || "");

		if (!selectedText || !selection.rangeCount) return;

		const range = selection.getRangeAt(0);
		if (!selectedPdfSegments(range).length) return;
		const rect = range.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) return;

		// Remove the old pill FIRST, then save the range —
		// removeFloatingPill() nulls savedRange, so saving before it wipes it.
		const clonedRange = range.cloneRange();
		removeFloatingPill();
		savedRange = clonedRange;

		const page = selection.anchorNode?.parentElement?.closest(".pdf-page");
		const context = contextFor(selection, page?.dataset.text || pageText);
		selectionData = { word: selectedText, context };
		currentDefinition = "";
		currentTone = "";
		currentSynonym = "";

		floatingPillContainer = document.createElement("div");
		floatingPillContainer.className = "cc-floating-pill-container";

		const isHighlighted = isRangeHighlighted(range);

		// Elements strictly in order:
		// 1. Text button: "Explain this" (Plain text only, clean dark font, NO icon)
		// 2. Thin vertical separator line (|)
		// 3. Highlighter icon button (outline highlighter nib icon)
		// 4. Note/Save icon button (folded corner notepad/sheet outline icon)
		floatingPillContainer.innerHTML = `
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
						<div class="cc-highlight-mode-divider"></div>
						<div class="cc-highlight-mode-label">Highlight color</div>
						<div class="cc-highlight-colors">
							<button class="cc-highlight-color-btn" data-color="yellow" aria-label="Yellow highlight" title="Yellow highlight"></button>
							<button class="cc-highlight-color-btn" data-color="green" aria-label="Green highlight" title="Green highlight"></button>
							<button class="cc-highlight-color-btn" data-color="blue" aria-label="Blue highlight" title="Blue highlight"></button>
							<button class="cc-highlight-color-btn" data-color="pink" aria-label="Pink highlight" title="Pink highlight"></button>
							<button class="cc-highlight-color-btn" data-color="orange" aria-label="Orange highlight" title="Orange highlight"></button>
						</div>
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
		`;

		// Prevent mousedown inside floating pill from clearing text selection prematurely
		floatingPillContainer.addEventListener("mousedown", (e) => {
			if (e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
				e.preventDefault();
			}
		});

		floatingPillContainer.addEventListener("mouseup", (e) => e.stopPropagation());

		// ── Smart positioning: flip above/below based on available viewport space ──
		document.body.appendChild(floatingPillContainer);

		const pillEl      = floatingPillContainer.querySelector(".cc-floating-pill");
		const pillWidth   = pillEl.offsetWidth  || 210;
		const pillHeight  = pillEl.offsetHeight || 38;

		const viewportH   = window.innerHeight;
		const viewportW   = window.innerWidth;
		const MARGIN      = 10; // px gap between pill and selection
		const EDGE_PAD    = 16; // min distance from viewport edges

		// Space available above and below the selection
		const spaceAbove  = rect.top - 56;          // 56 = toolbar height
		const spaceBelow  = viewportH - rect.bottom;

		// Prefer above; fall back to below only when not enough room above
		let top;
		let pillAbove; // true = pill is above the selection, card should open upward
		if (spaceAbove >= pillHeight + MARGIN) {
			top = rect.top - pillHeight - MARGIN;
			pillAbove = true;
		} else {
			top = rect.bottom + MARGIN;
			pillAbove = false;
		}

		// Clamp vertically so pill itself never goes off-screen
		top = Math.max(56 + MARGIN, Math.min(viewportH - pillHeight - EDGE_PAD, top));

		// Center horizontally on selection, clamp to viewport
		let left = rect.left + (rect.width - pillWidth) / 2;
		left = Math.max(EDGE_PAD, Math.min(viewportW - pillWidth - EDGE_PAD, left));

		floatingPillContainer.style.top  = `${Math.round(top)}px`;
		floatingPillContainer.style.left = `${Math.round(left)}px`;

		// Store direction so the card can open in the right direction
		floatingPillContainer.dataset.cardDir = pillAbove ? "up" : "down";

		// ── Drag to move ──────────────────────────────────────────────────────
		const dragHandle = floatingPillContainer.querySelector(".cc-drag-handle");
		let dragState = null;

		function stopDrag() {
			if (!dragState) return;
			dragState = null;
			floatingPillContainer?.classList.remove("cc-dragging");
			document.getElementById("cc-drag-cursor")?.remove();
			document.removeEventListener("mousemove",  onDragMove);
			document.removeEventListener("mouseup",    stopDrag);
			document.removeEventListener("mouseleave", stopDrag);
		}

		function onDragMove(e) {
			if (!dragState) return;
			const dx = e.clientX - dragState.startX;
			const dy = e.clientY - dragState.startY;
			const pillH   = floatingPillContainer.offsetHeight || 40;
			const pillW   = floatingPillContainer.offsetWidth  || 220;
			const TOP_PAD    = 56;  // toolbar height
			const BOTTOM_PAD = 80;  // safe margin above taskbar
			const SIDE_PAD   = 12;
			const newTop  = Math.max(TOP_PAD, Math.min(window.innerHeight - pillH - BOTTOM_PAD, dragState.origTop  + dy));
			const newLeft = Math.max(SIDE_PAD, Math.min(window.innerWidth  - pillW - SIDE_PAD,  dragState.origLeft + dx));
			floatingPillContainer.style.top  = `${Math.round(newTop)}px`;
			floatingPillContainer.style.left = `${Math.round(newLeft)}px`;
		}

		dragHandle.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();

			// If already dragging — clicking the handle again drops it in place
			if (dragState) {
				stopDrag();
				return;
			}

			const containerRect = floatingPillContainer.getBoundingClientRect();
			dragState = {
				startX:   e.clientX,
				startY:   e.clientY,
				origTop:  containerRect.top,
				origLeft: containerRect.left,
			};
			floatingPillContainer.classList.add("cc-dragging");

			// Global cursor override — beats every element-level cursor rule
			let cursorStyle = document.getElementById("cc-drag-cursor");
			if (!cursorStyle) {
				cursorStyle = document.createElement("style");
				cursorStyle.id = "cc-drag-cursor";
				document.head.appendChild(cursorStyle);
			}
			cursorStyle.textContent = "*, *::before, *::after { cursor: grabbing !important; }";

			document.addEventListener("mousemove",  onDragMove);
			document.addEventListener("mouseup",    stopDrag);
			document.addEventListener("mouseleave", stopDrag);
		});

		// Attach event listeners
		const explainBtn = floatingPillContainer.querySelector('[data-action="explain"]');
		const highlightBtn = floatingPillContainer.querySelector('[data-action="highlight"]');
		const saveBtn = floatingPillContainer.querySelector('[data-action="save"]');
		const highlightChevron = floatingPillContainer.querySelector('[data-action="highlight-mode"]');
		const highlightModePanel = floatingPillContainer.querySelector("#cc-highlight-mode-panel");
		const highlightModeBtns = floatingPillContainer.querySelectorAll(".cc-highlight-mode-btn");
		const highlightColorBtns = floatingPillContainer.querySelectorAll(".cc-highlight-color-btn");
		explainBtn.disabled = saveBtn.disabled = selectedText.length > 160;
		if (explainBtn.disabled) explainBtn.title = "Select up to 160 characters to explain; longer selections can be highlighted.";

		// Load persisted mode
		let highlightMode = "traditional";
		chrome.storage.local.get({ contentCoreHighlightMode: "traditional" }, ({ contentCoreHighlightMode }) => {
			highlightMode = contentCoreHighlightMode;
			highlightModeBtns.forEach(b => { b.dataset.active = String(b.dataset.mode === highlightMode); });
		});
		chrome.storage.local.get({ contentCoreHighlightColor: currentHighlightColor }, ({ contentCoreHighlightColor }) => {
			currentHighlightColor = normalizeHighlightColor(contentCoreHighlightColor);
			highlightColorBtns.forEach((btn) => {
				btn.dataset.active = String(btn.dataset.color === currentHighlightColor);
			});
		});
		highlightColorBtns.forEach((btn) => {
			const colorId = normalizeHighlightColor(btn.dataset.color);
			const swatch = HIGHLIGHT_COLORS[colorId];
			btn.style.setProperty("--cc-highlight-fill", swatch.fill);
			btn.style.setProperty("--cc-highlight-shadow", swatch.shadow);
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				currentHighlightColor = colorId;
				chrome.storage.local.set({ contentCoreHighlightColor: colorId });
				highlightColorBtns.forEach((item) => {
					item.dataset.active = String(item.dataset.color === colorId);
				});
			});
		});

		highlightBtn.addEventListener("click", () => {
			if (highlightMode === "pointer") {
				doPointerHighlight();
			} else {
				void toggleHighlight();
			}
		});

		highlightChevron.addEventListener("click", (e) => {
			e.stopPropagation();
			highlightModePanel.classList.toggle("open");
			themePanel.classList.remove("open");
		});

		highlightModeBtns.forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				highlightMode = btn.dataset.mode;
				chrome.storage.local.set({ contentCoreHighlightMode: highlightMode });
				highlightModeBtns.forEach(b => { b.dataset.active = String(b.dataset.mode === highlightMode); });
				highlightModePanel.classList.remove("open");
				if (highlightMode === "pointer") {
					doPointerHighlight();
				} else {
					void toggleHighlight();
				}
			});
		});

		// Outside clicks are handled by the shared pill-dismissal listener.
		// Closing here during document capture would hide swatches before click.

		explainBtn.addEventListener("click", () => {
			// If dropdown card already open, toggle it off
			const existingCard = floatingPillContainer.querySelector(".cc-dropdown-card");
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

			card.querySelector(".cc-card-close").addEventListener("click", removeFloatingPill);

			// Toast helper
			const cardToast = card.querySelector(".cc-card-toast");
			function showCardToast(msg) {
				cardToast.textContent = msg;
				cardToast.dataset.show = "true";
				setTimeout(() => { cardToast.dataset.show = "false"; }, 1400);
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
				await saveWord();
				showCardToast(isActive ? "Removed" : "Saved");
			});

			// Copy definition
			card.querySelector('[data-action="copy"]').addEventListener("click", async () => {
				const defText = currentDefinition || selectedText;
				try {
					await navigator.clipboard.writeText(defText);
					showCardToast("Copied");
				} catch {
					showCardToast("Copy failed");
				}
			});

			floatingPillContainer.appendChild(card);
			explainWord(card.querySelector(".cc-card-content"));

			// Keep the wider card and its pill inside the viewport.
			if (floatingPillContainer.dataset.cardDir === "up") {
				card.style.marginTop    = "0";
				card.style.marginBottom = "8px";
				card.style.order        = "-1"; // render card above pill in flex column
			}
			requestAnimationFrame(() => {
				const viewportPadding = 16;
				const rect = floatingPillContainer.getBoundingClientRect();
				const maxTop = Math.max(56 + 10, window.innerHeight - rect.height - viewportPadding);
				const top = Math.max(56 + 10, Math.min(maxTop, rect.top));
				const maxLeft = Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding);
				const left = Math.max(viewportPadding, Math.min(maxLeft, rect.left));
				floatingPillContainer.style.top = `${Math.round(top)}px`;
				floatingPillContainer.style.left = `${Math.round(left)}px`;
			});
		});

		saveBtn.addEventListener("click", saveWord);

		// Theme picker
		const themeBtn = floatingPillContainer.querySelector('[data-action="theme"]');
		const themePanel = floatingPillContainer.querySelector("#cc-theme-panel");
		const themeSwatches = floatingPillContainer.querySelectorAll(".cc-theme-swatch");
		themeBtn.addEventListener("mousedown", (e) => e.stopPropagation());

		function refreshThemeSwatches() {
			const currentTheme = _lastAppliedTheme || "warm-calm";
			themeSwatches.forEach((s) => {
				s.dataset.active = String(s.dataset.themeId === currentTheme);
			});
		}

		themeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			const isOpen = themePanel.classList.toggle("open");
			if (isOpen) refreshThemeSwatches();
			highlightModePanel?.classList.remove("open");
		});

		// Keep the word card on the selected theme when the menu closes.
		themeSwatches.forEach((swatch) => {
			swatch.addEventListener("mousedown", (e) => {
				e.preventDefault();
				e.stopPropagation();
			});

			// Click — commit permanently
			swatch.addEventListener("click", (e) => {
				e.stopPropagation();
				themeCommitVersion += 1;
				const chosen = swatch.dataset.themeId;
				applyTheme(chosen);
				chrome.storage.local.set({ contentCoreTheme: chosen });
				refreshThemeSwatches();
				refreshTbSwatches();
				themePanel.classList.remove("open");
				showToast("Theme saved");
			});
		});
	}

	// Page Navigation Helpers
	function updateNavButtonsState() {
		if (totalPages <= 0) {
			pagePrev.disabled = true;
			pageNext.disabled = true;
			pageNumInput.disabled = true;
			return;
		}
		pagePrev.disabled = currentPage <= 1;
		pageNext.disabled = currentPage >= totalPages;
		pageNumInput.disabled = false;
	}

	function scrollToPage(pageNumber, behavior = "smooth") {
		if (pageNumber < 1 || pageNumber > totalPages) return;
		const target = renderTarget.querySelector(`.pdf-page[data-page-number="${pageNumber}"]`);
		if (!target) return;

		isProgrammaticScroll = true;
		clearTimeout(scrollLockTimeout);

		currentPage = pageNumber;
		if (document.activeElement !== pageNumInput) {
			pageNumInput.value = String(currentPage);
		}
		updateNavButtonsState();

		const targetScrollTop = Math.max(0, target.offsetTop - 16);

		if (behavior === "smooth") {
			renderTarget.scrollTo({ top: targetScrollTop, behavior: "smooth" });
			scrollLockTimeout = setTimeout(() => {
				isProgrammaticScroll = false;
			}, 600);
		} else {
			renderTarget.scrollTop = targetScrollTop;
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					isProgrammaticScroll = false;
				});
			});
		}
	}

	// Active page detection using viewport intersection geometry during scroll
	function onScroll() {
		if (isProgrammaticScroll || isRendering || totalPages <= 0) return;
		if (scrollRafId) return;

		scrollRafId = requestAnimationFrame(() => {
			scrollRafId = null;
			if (isProgrammaticScroll || isRendering || totalPages <= 0) return;
			updateActivePageFromScroll();
		});
	}

	function updateActivePageFromScroll() {
		if (isProgrammaticScroll || isRendering || totalPages <= 0) return;
		const pages = renderTarget.querySelectorAll(".pdf-page");
		if (!pages.length) return;

		const scrollTop = renderTarget.scrollTop;

		let activePage = 1;
		// If at or near top of container (or rubber-band overscroll where scrollTop < 0), hard-lock activePage to 1
		if (scrollTop <= 10) {
			activePage = 1;
		} else {
			const containerRect = renderTarget.getBoundingClientRect();
			let maxVisibleHeight = -1;

			for (const pageEl of pages) {
				const pageRect = pageEl.getBoundingClientRect();
				const visibleHeight = Math.max(
					0,
					Math.min(pageRect.bottom, containerRect.bottom) - Math.max(pageRect.top, containerRect.top)
				);
				if (visibleHeight > maxVisibleHeight) {
					maxVisibleHeight = visibleHeight;
					activePage = parseInt(pageEl.dataset.pageNumber, 10) || 1;
				}
			}

			// If scrolled to the very bottom, set to last page
			if (scrollTop + renderTarget.clientHeight >= renderTarget.scrollHeight - 16) {
				activePage = totalPages;
			}
		}

		if (activePage !== currentPage) {
			currentPage = activePage;
			if (document.activeElement !== pageNumInput && !isProgrammaticScroll) {
				pageNumInput.value = String(currentPage);
			}
			updateNavButtonsState();
			// Persist current page so we can restore it after tab navigation
			savePageStateToIdb();
		}
	}

	// In-PDF Search / Find Bar Implementation
	function clearSearchHighlights() {
		const marks = document.querySelectorAll(".cc-find-highlight");
		marks.forEach(unwrapHighlight);
		findMatches = [];
		activeFindIndex = -1;
		findCount.style.display = "none";
		findPrev.disabled = true;
		findNext.disabled = true;
		restorePdfHighlights();
		refreshPointerHighlights();
	}

	function performSearch() {
		clearSearchHighlights();
		const query = findInput.value.trim();
		if (!query || !pdfDoc) return;

		const lowerQuery = query.toLowerCase();
		const spans = renderTarget.querySelectorAll(".text-layer [data-text-index]");

		spans.forEach((span) => {
			const text = span.textContent;
			if (!text) return;
			const lowerText = text.toLowerCase();
			let startIndex = 0;
			let matchIdx;

			if (lowerText.includes(lowerQuery)) {
				const fragment = document.createDocumentFragment();
				while ((matchIdx = lowerText.indexOf(lowerQuery, startIndex)) !== -1) {
					if (matchIdx > startIndex) {
						fragment.appendChild(document.createTextNode(text.slice(startIndex, matchIdx)));
					}
					const mark = document.createElement("mark");
					mark.className = "cc-find-highlight";
					mark.textContent = text.slice(matchIdx, matchIdx + query.length);
					fragment.appendChild(mark);
					findMatches.push(mark);
					startIndex = matchIdx + query.length;
				}
				if (startIndex < text.length) {
					fragment.appendChild(document.createTextNode(text.slice(startIndex)));
				}
				span.textContent = "";
				span.appendChild(fragment);
			}
		});

		restorePdfHighlights();
		refreshPointerHighlights();

		if (findMatches.length > 0) {
			activeFindIndex = 0;
			findCount.style.display = "inline";
			findCount.textContent = `1/${findMatches.length}`;
			findMatches[0].classList.add("cc-find-active");
			findMatches[0].scrollIntoView({ behavior: "smooth", block: "center" });
			findPrev.disabled = false;
			findNext.disabled = false;
		} else {
			findCount.style.display = "inline";
			findCount.textContent = "0/0";
			findPrev.disabled = true;
			findNext.disabled = true;
		}
	}

	function navigateFind(delta) {
		if (!findMatches.length) return;
		findMatches[activeFindIndex]?.classList.remove("cc-find-active");
		activeFindIndex = (activeFindIndex + delta + findMatches.length) % findMatches.length;
		const currentMatch = findMatches[activeFindIndex];
		currentMatch.classList.add("cc-find-active");
		findCount.textContent = `${activeFindIndex + 1}/${findMatches.length}`;
		currentMatch.scrollIntoView({ behavior: "smooth", block: "center" });
	}

	// Zoom Controls Implementation
	function updateZoomUI() {
		zoomBadge.textContent = `${Math.round(currentScale * 100)}%`;
		if (isRendering) {
			zoomOut.disabled = true;
			zoomIn.disabled = true;
		} else {
			zoomOut.disabled = !pdfDoc || currentScale <= ZOOM_STEPS[0];
			zoomIn.disabled = !pdfDoc || currentScale >= ZOOM_STEPS[ZOOM_STEPS.length - 1];
		}
	}

	async function applyZoom(newScale) {
		if (!pdfDoc) return;
		const targetPage = currentPage;

		isProgrammaticScroll = true;
		clearTimeout(scrollLockTimeout);

		currentScale = Math.max(ZOOM_STEPS[0], Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], newScale));
		updateZoomUI();

		await renderAllPages();

		// Immediately scroll #pdf-render so that target page's top is aligned to top of container
		const targetPageEl = renderTarget.querySelector(`.pdf-page[data-page-number="${targetPage}"]`);
		if (targetPageEl) {
			renderTarget.scrollTop = Math.max(0, targetPageEl.offsetTop - 16);
		}
		currentPage = targetPage;
		if (document.activeElement !== pageNumInput) {
			pageNumInput.value = String(currentPage);
		}
		updateNavButtonsState();

		await new Promise((resolve) => {
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					resolve();
				});
			});
		});
		isProgrammaticScroll = false;
	}

	function zoomStep(delta) {
		let closestIdx = 0;
		let minDiff = Infinity;
		ZOOM_STEPS.forEach((step, idx) => {
			const diff = Math.abs(step - currentScale);
			if (diff < minDiff) {
				minDiff = diff;
				closestIdx = idx;
			}
		});
		const targetIdx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, closestIdx + delta));
		applyZoom(ZOOM_STEPS[targetIdx]);
	}

	// Render All Pages using PDF.js
	async function renderAllPages() {
		if (renderAbortController) {
			renderAbortController.abort();
		}
		renderAbortController = new AbortController();
		const signal = renderAbortController.signal;

		isRendering = true;
		updateZoomUI();

		removeFloatingPill();
		clearSearchHighlights();
		pageText = "";
		const pageFragment = document.createDocumentFragment();

		try {
			const pdf = pdfDoc;
			if (!pdf) return;

			for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
				if (signal.aborted) return;
				const page = await pdf.getPage(pageNumber);
				if (signal.aborted) return;
				const dpr = window.devicePixelRatio || 1;
				const viewport = page.getViewport({ scale: currentScale });
				// High-DPI viewport — render at physical pixel resolution for crisp output
				const hiDpiViewport = page.getViewport({ scale: currentScale * dpr });

				const wrapper = document.createElement("section");
				wrapper.className = "pdf-page";
				wrapper.dataset.pageNumber = String(pageNumber);
				wrapper.style.width = `${viewport.width}px`;
				wrapper.style.height = `${viewport.height}px`;
				wrapper.style.minHeight = `${viewport.height}px`;

				const canvas = document.createElement("canvas");
				canvas.width  = Math.floor(hiDpiViewport.width);
				canvas.height = Math.floor(hiDpiViewport.height);
				canvas.style.width  = `${viewport.width}px`;
				canvas.style.height = `${viewport.height}px`;

				const ctx = canvas.getContext("2d");
				wrapper.appendChild(canvas);

				const textLayer = document.createElement("div");
				textLayer.className = "text-layer";
				textLayer.style.width = `${viewport.width}px`;
				textLayer.style.height = `${viewport.height}px`;

				const textContent = await page.getTextContent();
				if (signal.aborted) return;
				const pageLines = textContent.items.filter(item => typeof item.str === "string").map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("");
				const pageTextClean = pageLines.split("\n").map(clean).filter(Boolean).join("\n");
				pageText += `${clean(pageTextClean)} `;
				wrapper.dataset.text = pageTextClean;

				textLayer.style.setProperty("--total-scale-factor", viewport.scale * (viewport.userUnit || 1));
				const textTask = new globalThis.pdfjsLib.TextLayer({
					textContentSource: textContent, container: textLayer, viewport
				});
				const cancelText = () => textTask.cancel();
				signal.addEventListener("abort", cancelText, { once: true });
				try {
					await textTask.render();
				} catch (error) {
					if (signal.aborted) return;
					throw error;
				} finally {
					signal.removeEventListener("abort", cancelText);
				}
				if (signal.aborted) return;
				textTask.textDivs.forEach((span, index) => { span.dataset.textIndex = String(index); });

				wrapper.appendChild(textLayer);
				const renderTask = page.render({ canvasContext: ctx, viewport: hiDpiViewport });
				signal.addEventListener("abort", () => {
					try {
						renderTask.cancel();
					} catch (_) {}
				}, { once: true });

				try {
					await renderTask.promise;
				} catch (renderErr) {
					if (signal.aborted || renderErr?.name === "RenderingCancelledException") {
						return;
					}
					throw renderErr;
				}
				if (signal.aborted) return;
				pageFragment.appendChild(wrapper);
				restorePdfHighlights(wrapper);
			}

			renderTarget.replaceChildren(pageFragment);
			pageText = clean(pageText);
			if (findInput.value.trim()) performSearch();
			refreshPointerHighlights();
		} finally {
			if (renderAbortController?.signal === signal) {
				isRendering = false;
				updateZoomUI();
			}
		}
	}

	// Main Load PDF File Function
	async function loadPdf(file) {
		if (renderAbortController) {
			renderAbortController.abort();
		}
		removeFloatingPill();
		docTitle.textContent = file.name;
		docTitle.title = file.name;
		currentDocument = file.name;
		pdfHighlights = [];
		currentPdfFingerprint = "";
		if (emptyState) emptyState.style.display = "none";

		const loadingOverlay = document.querySelector("#pdf-loading-overlay");
		if (loadingOverlay) loadingOverlay.style.display = "flex";

		isProgrammaticScroll = true;
		clearTimeout(scrollLockTimeout);
		renderTarget.scrollTop = 0;

		try {
			const pdfjs = globalThis.pdfjsLib;
			if (!pdfjs) throw new Error("PDF.js library not loaded. Please reload the extension.");
			pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdfjs/pdf.worker.min.js");

			pdfRawData = await file.arrayBuffer();
			// Copy the buffer BEFORE passing to PDF.js — getDocument() transfers
			// (neuters) the ArrayBuffer to the worker, making it unusable afterwards.
			const bufferForIdb = pdfRawData.slice(0);
			currentPdfFingerprint = await computePdfFingerprint(bufferForIdb);
			await loadStoredHighlightsForCurrentPdf();
			pdfDoc = await pdfjs.getDocument({ data: pdfRawData }).promise;
			totalPages = pdfDoc.numPages;
			// Persist the pre-copy to IndexedDB so it survives tab navigation
			savePdfToIdb(bufferForIdb, file.name);
			currentPage = 1;

			// Update Toolbar Controls
			pageCountDisplay.textContent = `/ ${totalPages}`;
			pageNumInput.max = String(totalPages);
			pageNumInput.value = "1";
			pageNumInput.disabled = false;
			pagePrev.disabled = true;
			pageNext.disabled = totalPages <= 1;

			findInput.disabled = false;
			findBtn.disabled = false;
			fitToggleBtn.disabled = false;

			currentScale = 1.0;
			updateZoomUI();
			await renderAllPages();

			renderTarget.scrollTop = 0;
			currentPage = 1;
			pageNumInput.value = "1";
			updateNavButtonsState();

			await new Promise((resolve) => {
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						resolve();
					});
				});
			});
			isProgrammaticScroll = false;

			if (loadingOverlay) loadingOverlay.style.display = "none";
			showToast(`${totalPages} page${totalPages === 1 ? "" : "s"} loaded`);
		} catch (error) {
			console.error("[arth.find] Error loading PDF:", error);
			if (loadingOverlay) loadingOverlay.style.display = "none";
			docTitle.textContent = "Error loading PDF";
			showToast(`Failed to load PDF: ${error.message}`);
			isProgrammaticScroll = false;
		}
	}

	async function loadPdfFromUrl(pdfUrl) {
		try {
			const response = await fetch(pdfUrl);
			if (!response.ok) throw new Error(`PDF request failed (${response.status})`);
			const blob = await response.blob();
			const urlPath = new URL(pdfUrl).pathname;
			const fileName = decodeURIComponent(urlPath.split("/").pop() || "Document.pdf").replace(/[^\w.\- ()]/g, "_");
			const file = new File([blob], fileName.toLowerCase().endsWith(".pdf") ? fileName : `${fileName}.pdf`, {
				type: "application/pdf"
			});
			await loadPdf(file);
		} catch (error) {
			console.error("[arth.find] Error downloading PDF URL:", error);
			showToast(`Could not open PDF: ${error.message}`);
		}
	}

	// Fit Toggle Handler
	async function toggleFit() {
		if (!pdfDoc) return;
		if (!isFitWidth) {
			try {
				const firstPage = await pdfDoc.getPage(1);
				const unscaledViewport = firstPage.getViewport({ scale: 1.0 });
				const availableWidth = renderTarget.clientWidth - 48;
				let calculatedScale = availableWidth / unscaledViewport.width;
				calculatedScale = Math.round(calculatedScale * 100) / 100;
				isFitWidth = true;
				fitToggleBtn.classList.add("active");
				await applyZoom(calculatedScale);
			} catch (e) {
				console.error("Fit calculation error:", e);
			}
		} else {
			isFitWidth = false;
			fitToggleBtn.classList.remove("active");
			await applyZoom(1.0);
		}
	}

	// Setup Event Listeners
	function initEvents() {
		// Scroll Listener on #pdf-render (throttled via RAF)
		renderTarget.addEventListener("scroll", onScroll, { passive: true });

		// File Input
		fileInput.addEventListener("change", () => {
			if (fileInput.files[0]) {
				loadPdf(fileInput.files[0]);
			}
		});

		// Drag and Drop
		window.addEventListener("dragover", (e) => {
			e.preventDefault();
			emptyState?.classList.add("drag-over");
		});

		window.addEventListener("dragleave", (e) => {
			if (e.relatedTarget === null) {
				emptyState?.classList.remove("drag-over");
			}
		});

		window.addEventListener("drop", (e) => {
			e.preventDefault();
			emptyState?.classList.remove("drag-over");
			const file = e.dataTransfer?.files[0];
			if (file && file.type === "application/pdf") {
				loadPdf(file);
			}
		});

		// Page Navigation Events
		pagePrev.addEventListener("click", () => {
			if (currentPage > 1) scrollToPage(currentPage - 1);
		});

		pageNext.addEventListener("click", () => {
			if (currentPage < totalPages) scrollToPage(currentPage + 1);
		});

		pageNumInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				pageNumInput.blur();
			}
		});

		pageNumInput.addEventListener("change", () => {
			const target = parseInt(pageNumInput.value, 10);
			if (!isNaN(target) && target >= 1 && target <= totalPages) {
				scrollToPage(target);
			} else {
				pageNumInput.value = currentPage;
			}
		});

		// Zoom Events
		zoomOut.addEventListener("click", () => zoomStep(-1));
		zoomIn.addEventListener("click", () => zoomStep(1));
		fitToggleBtn.addEventListener("click", toggleFit);

		// Find / Search Events
		findInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				if (e.shiftKey) {
					navigateFind(-1);
				} else if (findMatches.length > 0) {
					navigateFind(1);
				} else {
					performSearch();
				}
			} else if (e.key === "Escape") {
				clearSearchHighlights();
				findInput.value = "";
			}
		});

		findInput.addEventListener("input", () => {
			if (!findInput.value.trim()) {
				clearSearchHighlights();
			}
		});

		findBtn.addEventListener("click", performSearch);
		findPrev.addEventListener("click", () => navigateFind(-1));
		findNext.addEventListener("click", () => navigateFind(1));

		// Text Selection & Floating Pill
		document.addEventListener("mouseup", (e) => {
			// Never trigger on pill UI or during drag
			if (floatingPillContainer?.contains(e.target)) return;
			if (floatingPillContainer?.classList.contains("cc-dragging")) return;
			setTimeout(showFloatingPill, 60);
		});

		document.addEventListener("mousedown", (e) => {
			// Don't dismiss while a drag is in progress
			if (floatingPillContainer?.classList.contains("cc-dragging")) return;
			// Only dismiss if the pill is actually visible AND the click is outside it
			if (floatingPillContainer && !floatingPillContainer.contains(e.target)) {
				removeFloatingPill();
			}
		});

		window.addEventListener("resize", () => {
			if (floatingPillContainer) removeFloatingPill();
		});

		// Keyboard zoom — +/= to zoom in, - to zoom out, 0 to reset
		document.addEventListener("keydown", (e) => {
			// Skip if user is typing in an input
			if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
			if (!pdfDoc) return;

			if (e.key === "+" || e.key === "=") {
				e.preventDefault();
				zoomStep(1);
			} else if (e.key === "-") {
				e.preventDefault();
				zoomStep(-1);
			} else if (e.key === "0" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				applyZoom(1.0);
			} else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
				if (currentPage < totalPages) scrollToPage(currentPage + 1);
			} else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
				if (currentPage > 1) scrollToPage(currentPage - 1);
			}
		});

		// Shortcuts panel toggle
		const tbShortcutsBtn = document.querySelector("#tb-shortcuts-btn");
		const tbShortcutsPanel = document.querySelector("#tb-shortcuts-panel");

		tbShortcutsBtn?.addEventListener("click", (e) => {
			e.stopPropagation();
			const isOpen = tbShortcutsPanel.classList.toggle("open");
			tbShortcutsBtn.classList.toggle("active", isOpen);
			// close other panels
			tbThemePanel?.classList.remove("open");
			tbThemeBtn?.classList.remove("active");
		});

		document.addEventListener("mousedown", (e) => {
			if (tbShortcutsPanel && !tbShortcutsBtn.contains(e.target) && !tbShortcutsPanel.contains(e.target)) {
				tbShortcutsPanel.classList.remove("open");
				tbShortcutsBtn.classList.remove("active");
			}
		});
	}

	// ── IndexedDB Persistence ──────────────────────────────────────────────────
	// Stores the raw PDF ArrayBuffer + reading position so the document survives
	// tab navigation and restores exactly where the user left off.

	const IDB_NAME    = "contentCorePdfStore";
	const IDB_VERSION = 1;
	const IDB_STORE   = "pdfs";
	const IDB_KEY     = "lastPdf";

	function openIdb() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(IDB_NAME, IDB_VERSION);
			req.onupgradeneeded = (e) => {
				e.target.result.createObjectStore(IDB_STORE);
			};
			req.onsuccess = (e) => resolve(e.target.result);
			req.onerror   = (e) => reject(e.target.error);
		});
	}

	async function savePdfToIdb(arrayBuffer, fileName) {
		try {
			const db    = await openIdb();
			const tx    = db.transaction(IDB_STORE, "readwrite");
			const store = tx.objectStore(IDB_STORE);
			store.put({ buffer: arrayBuffer, name: fileName, page: 1, scale: 1.0, savedAt: Date.now() }, IDB_KEY);
			// Mark this tab session so navigating to Saved Words and back restores correctly
			sessionStorage.setItem("arthfindPdfSession", "1");
			return new Promise((resolve, reject) => {
				tx.oncomplete = () => { db.close(); resolve(); };
				tx.onerror    = (e) => { db.close(); reject(e.target.error); };
			});
		} catch (err) {
			console.warn("[arth.find] IDB save failed:", err);
		}
	}

	// Debounced — fires ~600ms after the user stops scrolling
	let _pageStateSaveTimer = null;
	function savePageStateToIdb() {
		clearTimeout(_pageStateSaveTimer);
		_pageStateSaveTimer = setTimeout(async () => {
			try {
				const db    = await openIdb();
				const tx    = db.transaction(IDB_STORE, "readwrite");
				const store = tx.objectStore(IDB_STORE);
				const req   = store.get(IDB_KEY);
				req.onsuccess = (e) => {
					const record = e.target.result;
					if (!record) { db.close(); return; }
					record.page  = currentPage;
					record.scale = currentScale;
					store.put(record, IDB_KEY);
					tx.oncomplete = () => db.close();
				};
			} catch { /* ignore */ }
		}, 600);
	}

	async function loadPdfFromIdb() {
		try {
			const db    = await openIdb();
			const tx    = db.transaction(IDB_STORE, "readonly");
			const store = tx.objectStore(IDB_STORE);
			const req   = store.get(IDB_KEY);
			return new Promise((resolve) => {
				req.onsuccess = (e) => { db.close(); resolve(e.target.result || null); };
				req.onerror   = ()  => { db.close(); resolve(null); };
			});
		} catch {
			return null;
		}
	}

	async function clearPdfFromIdb() {
		try {
			const db    = await openIdb();
			const tx    = db.transaction(IDB_STORE, "readwrite");
			tx.objectStore(IDB_STORE).delete(IDB_KEY);
			db.close();
		} catch { /* ignore */ }
	}

	// Silently restore the last PDF and jump to the saved page + scale
	// Only restores within the same browser session — not across fresh opens.
	async function tryRestoreLastPdf() {
		const record = await loadPdfFromIdb();
		if (!record?.buffer) return;

		// Check if this is a same-session navigation or uploaded from popup
		// sessionStorage is cleared when the tab/window is closed, so a fresh open won't have the flag.
		const urlParams = new URLSearchParams(window.location.search);
		const fromUpload = urlParams.get("fromUpload");
		const sessionId = sessionStorage.getItem("arthfindPdfSession");
		if (!sessionId && !fromUpload) {
			// Fresh open — don't auto-load the old PDF, but don't delete it either
			// (user may navigate to saved-words and come back within the same session)
			return;
		}

		if (fromUpload) {
			sessionStorage.setItem("arthfindPdfSession", "1");
		}

		const blob = new Blob([record.buffer], { type: "application/pdf" });
		const file = new File([blob], record.name, { type: "application/pdf" });

		await loadPdf(file);

		// Restore scale first, then jump to saved page
		const savedPage  = record.page  || 1;
		const savedScale = record.scale || 1.0;

		if (savedScale !== 1.0) {
			await applyZoom(savedScale);
		}

		if (savedPage > 1) {
			scrollToPage(savedPage, "instant");
		}
	}

	// ── Initialize
	initEvents();
	const initialPdfUrl = new URLSearchParams(window.location.search).get("pdfUrl");
	if (initialPdfUrl) {
		loadPdfFromUrl(initialPdfUrl);
	} else {
		tryRestoreLastPdf();
	}

	// Clear stored PDF when the tab/window is closed or the user navigates away permanently.
	// pagehide fires for both tab close and navigation; we only want to clear when the page
	// is NOT being kept in the bfcache (persisted = false), which covers true exits.
	// For same-session navigation (e.g. → Saved Words), the session flag is already set so
	// restore still works on the way back, but on a real close the IDB is wiped clean.
	window.addEventListener("pagehide", (e) => {
		if (!e.persisted) {
			// Use sendBeacon-style synchronous IDB delete — best-effort on page unload
			clearPdfFromIdb();
		}
	});
})();
