(() => {
	"use strict";

	const STORAGE_KEY = "contentCoreSavedWords";

	let allWords = [];
	let currentFilter = "";

	const cardsContainer = document.querySelector("#cards-container");
	const emptyState = document.querySelector("#empty-state");
	const noResultsState = document.querySelector("#no-results-state");
	const searchInput = document.querySelector("#search-input");
	const searchClear = document.querySelector("#search-clear");
	const exportBtn = document.querySelector("#export-btn");
	const clearAllBtn = document.querySelector("#clear-all-btn");
	const wordCountBadge = document.querySelector("#word-count-badge");

	function clean(value) {
		return String(value || "").replace(/\s+/g, " ").trim();
	}

	function formatDate(timestamp) {
		if (!timestamp) return "";
		try {
			const date = new Date(timestamp);
			if (isNaN(date.getTime())) return "";
			const datePart = date.toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
				year: "numeric"
			});
			const timePart = date.toLocaleTimeString(undefined, {
				hour: "numeric",
				minute: "2-digit",
				hour12: true
			});
			return `${datePart} · ${timePart}`;
		} catch {
			return "";
		}
	}

	function escapeHtml(text) {
		const div = document.createElement("div");
		div.textContent = text || "";
		return div.innerHTML;
	}

	function escapeCsv(value) {
		if (value === null || value === undefined) return '""';
		const str = String(value).replace(/"/g, '""');
		return `"${str}"`;
	}

	async function loadSavedWords() {
		try {
			const stored = await chrome.storage.local.get(STORAGE_KEY);
			allWords = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
		} catch (error) {
			console.error("[ContentCore] Failed to load saved words:", error);
			allWords = [];
		}
		render();
	}

	function getFilteredWords() {
		if (!currentFilter) return allWords;
		const query = currentFilter.toLowerCase();
		return allWords.filter((item) => {
			const word = String(item.word || "").toLowerCase();
			const definition = String(item.definition || "").toLowerCase();
			const context = String(item.context || "").toLowerCase();
			const source = String(item.url || item.document || "").toLowerCase();
			return word.includes(query) ||
				definition.includes(query) ||
				context.includes(query) ||
				source.includes(query);
		});
	}

	function updateStats(filteredCount, totalCount) {
		if (totalCount === 0) {
			wordCountBadge.textContent = "0 words saved";
			exportBtn.disabled = true;
			clearAllBtn.disabled = true;
		} else {
			exportBtn.disabled = false;
			clearAllBtn.disabled = false;
			if (currentFilter) {
				wordCountBadge.textContent = `${filteredCount} of ${totalCount} word${totalCount === 1 ? "" : "s"}`;
			} else {
				wordCountBadge.textContent = `${totalCount} word${totalCount === 1 ? "" : "s"} saved`;
			}
		}
	}

	function render() {
		const totalCount = allWords.length;
		const filtered = getFilteredWords();
		const filteredCount = filtered.length;

		updateStats(filteredCount, totalCount);

		if (totalCount === 0) {
			cardsContainer.innerHTML = "";
			emptyState.style.display = "block";
			noResultsState.style.display = "none";
			return;
		}

		emptyState.style.display = "none";

		if (filteredCount === 0) {
			cardsContainer.innerHTML = "";
			noResultsState.style.display = "block";
			return;
		}

		noResultsState.style.display = "none";

		cardsContainer.innerHTML = filtered.map((item) => {
			const word = clean(item.word);
			const definition = clean(item.definition);
			const context = clean(item.context);
			const hasLongContext = context.length > 240;
			const formattedDate = formatDate(item.savedAt);
			const originalIndex = allWords.indexOf(item);

			let sourceHtml = "";
			if (item.url) {
				try {
					const parsed = new URL(item.url);
					const domain = parsed.hostname + (parsed.pathname.length > 20 ? parsed.pathname.slice(0, 20) + "..." : parsed.pathname);
					sourceHtml = `
						<a class="source-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(item.url)}">
							🔗 ${escapeHtml(domain)}
						</a>
					`;
				} catch {
					sourceHtml = `
						<a class="source-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(item.url)}">
							🔗 ${escapeHtml(item.url)}
						</a>
					`;
				}
			} else if (item.document) {
				sourceHtml = `
					<span class="source-pdf" title="${escapeHtml(item.document)}">
						📄 PDF: ${escapeHtml(item.document)}
					</span>
				`;
			}

			const contextHtml = context
				? `<div class="context-box${hasLongContext ? " is-collapsed" : ""}">
					<div class="context-text">${escapeHtml(context)}</div>
					${hasLongContext ? '<button type="button" class="context-toggle" aria-expanded="false">Read more</button>' : ""}
				</div>`
				: "";

			const dateHtml = formattedDate
				? `<div class="date-text">Saved ${escapeHtml(formattedDate)}</div>`
				: "";

			return `
				<article class="word-card" data-index="${originalIndex}">
					<div class="card-header">
						<h2 class="word-title">${escapeHtml(word)}</h2>
						<button
							type="button"
							class="card-delete-btn"
							data-delete-index="${originalIndex}"
							aria-label="Remove word ${escapeHtml(word)}"
							title="Remove from saved words"
						>&times;</button>
					</div>
					<div class="definition-box">${escapeHtml(definition)}</div>
					${contextHtml}
					<div class="card-footer">
						${sourceHtml}
						${dateHtml}
					</div>
				</article>
			`;
		}).join("");
	}

	async function deleteWord(index) {
		if (index < 0 || index >= allWords.length) return;
		allWords.splice(index, 1);
		await chrome.storage.local.set({ [STORAGE_KEY]: allWords });
		render();
	}

	async function clearAllWords() {
		if (allWords.length === 0) return;
		const confirmed = window.confirm(
			"Are you sure you want to delete all saved words? This cannot be undone."
		);
		if (confirmed) {
			allWords = [];
			await chrome.storage.local.set({ [STORAGE_KEY]: [] });
			render();
		}
	}

	function exportCsv() {
		if (allWords.length === 0) return;

		const headers = ["Word", "Definition", "Context", "Source", "Date"];
		const rows = allWords.map((item) => {
			const word = item.word || "";
			const definition = item.definition || "";
			const context = item.context || "";
			const source = item.url || item.document || "";
			const date = formatDate(item.savedAt) || (item.savedAt ? new Date(item.savedAt).toISOString() : "");
			return [
				escapeCsv(word),
				escapeCsv(definition),
				escapeCsv(context),
				escapeCsv(source),
				escapeCsv(date)
			].join(",");
		});

		const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
		const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
		const url = URL.createObjectURL(blob);

		const downloadLink = document.createElement("a");
		downloadLink.href = url;
		downloadLink.download = `contentcore-saved-words-${new Date().toISOString().slice(0, 10)}.csv`;
		document.body.appendChild(downloadLink);
		downloadLink.click();
		document.body.removeChild(downloadLink);
		URL.revokeObjectURL(url);
	}

	// Event Handlers
	cardsContainer.addEventListener("click", (event) => {
		const deleteBtn = event.target.closest("[data-delete-index]");
		if (deleteBtn) {
			const index = parseInt(deleteBtn.getAttribute("data-delete-index"), 10);
			if (!isNaN(index)) {
				deleteWord(index);
			}
		}

			const contextToggle = event.target.closest(".context-toggle");
			if (contextToggle) {
				const contextBox = contextToggle.closest(".context-box");
				const expanded = contextBox.classList.toggle("is-expanded");
				contextBox.classList.toggle("is-collapsed", !expanded);
				contextToggle.setAttribute("aria-expanded", String(expanded));
				contextToggle.textContent = expanded ? "Read less" : "Read more";
			}
	});

	searchInput.addEventListener("input", () => {
		currentFilter = clean(searchInput.value);
		searchClear.style.display = currentFilter ? "block" : "none";
		render();
	});

	searchClear.addEventListener("click", () => {
		searchInput.value = "";
		currentFilter = "";
		searchClear.style.display = "none";
		searchInput.focus();
		render();
	});

	exportBtn.addEventListener("click", exportCsv);
	clearAllBtn.addEventListener("click", clearAllWords);

	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName === "local" && changes[STORAGE_KEY]) {
			allWords = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
			render();
		}
	});

	document.addEventListener("DOMContentLoaded", loadSavedWords);
})();
