(() => {
	"use strict";

	const NOTIFICATION_PREFIX = "arthfind-pdf-";

	function getPdfUrl(tabUrl) {
		if (!tabUrl || !/^(?:https?|file):\/\//i.test(tabUrl)) return null;
		try {
			const url = new URL(tabUrl);
			if (/\.pdf$/i.test(url.pathname)) {
				return url.href;
			}
		} catch (error) {
			console.warn("[arth.find] Could not inspect tab URL:", error);
		}
		return null;
	}

	function showPdfPrompt(tabId) {
		const notificationId = `${NOTIFICATION_PREFIX}${tabId}`;
		chrome.notifications.create(notificationId, {
			type: "basic",
			iconUrl: "icon-128.png",
			title: "Open PDF in Arth.Find?",
			message: "This PDF is open in Chrome. Open it in Arth.Find to highlight and save notes permanently.",
			buttons: [{ title: "Open in Arth.Find" }],
			requireInteraction: true,
			priority: 1
		}, () => {
			if (chrome.runtime.lastError) {
				console.warn("[arth.find] Could not show PDF prompt:", chrome.runtime.lastError.message);
			}
		});
	}

	chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
		if (changeInfo.status !== "complete") return;
		const pdfUrl = getPdfUrl(tab.url);
		if (!pdfUrl) return;
		showPdfPrompt(tabId);
	});

	chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
		if (buttonIndex !== 0 || !notificationId.startsWith(NOTIFICATION_PREFIX)) return;
		const tabId = Number(notificationId.slice(NOTIFICATION_PREFIX.length));
		chrome.tabs.get(tabId, (tab) => {
			if (chrome.runtime.lastError || !tab?.url) return;
			const pdfUrl = getPdfUrl(tab.url);
			if (!pdfUrl) return;
			const readerUrl = chrome.runtime.getURL(`pdf-viewer.html?pdfUrl=${encodeURIComponent(pdfUrl)}`);
			chrome.tabs.update(tabId, { url: readerUrl });
		});
		chrome.notifications.clear(notificationId);
	});
})();
