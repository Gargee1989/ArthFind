(() => {
	"use strict";

	// =========================================================================
	// BACKEND CONFIGURATION
	// =========================================================================
	const BACKEND_ENDPOINT = "https://arthfind-backend.onrender.com/define";

	function getCredentialsEndpoint(endpoint = BACKEND_ENDPOINT) {
		const url = new URL(endpoint);
		url.pathname = url.pathname.replace(/\/define\/?$/, "/credentials");
		return url.toString();
	}

	const KEY_STORAGE = "contentCoreEncryptionKey";
	const ENCRYPTED_SUFFIX = "Encrypted";
	const AES_ALGORITHM = "AES-GCM";
	const KEY_LENGTH = 256;
	const IV_LENGTH = 12;

	function toBase64(bytes) {
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary);
	}

	function fromBase64(value) {
		const binary = atob(value);
		return Uint8Array.from(binary, (character) => character.charCodeAt(0));
	}

	async function getKey(create = false) {
		const stored = await chrome.storage.local.get(KEY_STORAGE);
		if (stored[KEY_STORAGE]) {
			return crypto.subtle.importKey(
			"raw",
			fromBase64(stored[KEY_STORAGE]),
			{ name: AES_ALGORITHM },
			false,
			["encrypt", "decrypt"]
		);
		}
		if (!create) {
			throw new Error("The saved connection cannot be unlocked in this browser profile.");
		}

		const key = await crypto.subtle.generateKey(
			{ name: AES_ALGORITHM, length: KEY_LENGTH },
			true,
			["encrypt", "decrypt"]
		);
		const rawKey = await crypto.subtle.exportKey("raw", key);
		await chrome.storage.local.set({
			[KEY_STORAGE]: toBase64(new Uint8Array(rawKey))
		});
		return crypto.subtle.importKey(
			"raw",
			rawKey,
			{ name: AES_ALGORITHM },
			false,
			["encrypt", "decrypt"]
		);
	}

	async function encrypt(value) {
		if (!value) return "";
		const key = await getKey(true);
		const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
		const encoded = new TextEncoder().encode(value);
		const ciphertext = await crypto.subtle.encrypt(
			{ name: AES_ALGORITHM, iv },
			key,
			encoded
		);
		return JSON.stringify({
			iv: toBase64(iv),
			ciphertext: toBase64(new Uint8Array(ciphertext))
		});
	}

	async function decrypt(value) {
		if (!value) return "";
		const payload = typeof value === "string" ? JSON.parse(value) : value;
		const key = await getKey();
		const plaintext = await crypto.subtle.decrypt(
			{ name: AES_ALGORITHM, iv: fromBase64(payload.iv) },
			key,
			fromBase64(payload.ciphertext)
		);
		return new TextDecoder().decode(plaintext);
	}

	async function readSettings() {
		const settings = await chrome.storage.local.get([
			"contentCoreEndpoint",
			"contentCoreCredentialId",
			"contentCoreCredentialTokenEncrypted",
			"contentCoreProvider",
			"contentCoreLlmModel"
		]);

		const decrypted = { ...settings };
		if (settings.contentCoreCredentialTokenEncrypted) {
			try {
				decrypted.contentCoreCredentialToken = await decrypt(
					settings.contentCoreCredentialTokenEncrypted
				);
			} catch {
				decrypted.contentCoreCredentialToken = "";
			}
		}
		await chrome.storage.local.remove([
			"contentCoreApiKey",
			"contentCoreApiKeyEncrypted",
			"contentCoreLlmApiKey",
			"contentCoreLlmApiKeyEncrypted",
		]);
		return decrypted;
	}

	globalThis.ContentCoreCrypto = {
		encrypt,
		decrypt,
		readSettings,
		BACKEND_ENDPOINT,
		getCredentialsEndpoint,
	};
})();
