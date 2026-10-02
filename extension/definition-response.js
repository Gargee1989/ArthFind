/* Read progressive definitions while retaining compatibility with JSON backends. */
(() => {
	async function read(response, onMeaning = () => {}) {
		if (!response.headers.get("content-type")?.includes("text/event-stream")) {
			return response.json();
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let event = "message";
		let data = [];
		let result;
		function consume(line) {
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) {
				if (data.length) {
					const value = JSON.parse(data.join("\n"));
					if (event === "meaning" && typeof value.meaning === "string") onMeaning(value.meaning);
					if (event === "result") result = value;
					if (event === "error") throw new Error(value.message || "Definition service unavailable.");
				}
				event = "message";
				data = [];
			} else if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
		}
		try {
			while (true) {
				const { value, done } = await reader.read();
				buffer += decoder.decode(value, { stream: !done });
				if (buffer.length > 200000) throw new Error("Definition response is too large.");
				let newline;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					consume(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
				}
				if (done) break;
			}
			if (!result) throw new Error("The explanation was interrupted. Please try again.");
			return result;
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
	globalThis.ContentCoreDefinition = { read };
})();
