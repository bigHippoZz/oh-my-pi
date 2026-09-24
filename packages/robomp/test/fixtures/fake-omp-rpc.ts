/**
 * Minimal `omp --mode rpc` stand-in for adapter tests.
 *
 * Handles `set_host_tools`, `set_todos`, `get_state` and `prompt`. A prompt
 * emits confirm, select, input and editor extension UI requests plus requests
 * that must go unanswered (passive notify, `cancel`, an unknown method), waits
 * for replies to the four interactive ones, and ends the turn with an
 * assistant message whose text is the JSON of those replies. The prompt
 * "reject" answers with a failed response; `set_todos` with a phase named
 * "reject" does too.
 */
const out = (frame: unknown): void => {
	process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const uiWaiters = new Map<string, (reply: unknown) => void>();
/** Requests a headless host must leave unanswered: `[id, method]`. */
const UNANSWERED = [
	["ui-notify", "notify"],
	["ui-cancel", "cancel"],
	["ui-unknown", "mystery"],
] as const;
let todoPhases: unknown[] = [];

async function runPrompt(): Promise<void> {
	out({ type: "agent_start" });
	const replies = ["ui-confirm", "ui-select", "ui-input", "ui-editor"].map(id => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		uiWaiters.set(id, resolve);
		return promise;
	});
	out({ type: "extension_ui_request", id: "ui-confirm", method: "confirm", title: "Proceed?", message: "?" });
	out({ type: "extension_ui_request", id: "ui-select", method: "select", title: "Pick", options: ["a", "b"] });
	out({ type: "extension_ui_request", id: "ui-input", method: "input", title: "Name" });
	out({ type: "extension_ui_request", id: "ui-editor", method: "editor", title: "Edit" });
	for (const [id, method] of UNANSWERED) out({ type: "extension_ui_request", id, method, message: "fyi" });
	const text = JSON.stringify(await Promise.all(replies));
	const assistant = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
	out({ type: "message_end", message: assistant });
	out({ type: "agent_end", messages: [assistant] });
}

out({ type: "ready" });
const decoder = new TextDecoder();
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
	buffered += decoder.decode(chunk, { stream: true });
	let newline = buffered.indexOf("\n");
	while (newline >= 0) {
		const line = buffered.slice(0, newline).trim();
		buffered = buffered.slice(newline + 1);
		newline = buffered.indexOf("\n");
		if (!line) continue;
		const frame = JSON.parse(line) as {
			type: string;
			id?: string;
			message?: string;
			phases?: Array<{ name?: string }>;
		};
		const respond = (data: unknown): void =>
			out({ type: "response", id: frame.id, command: frame.type, success: true, data });
		switch (frame.type) {
			case "extension_ui_response":
				if (UNANSWERED.some(([id]) => id === frame.id)) throw new Error(`${frame.id} must not be answered`);
				uiWaiters.get(frame.id!)?.(frame);
				break;
			case "set_todos":
				if (frame.phases?.some(phase => phase.name === "reject")) {
					out({ type: "response", id: frame.id, command: "set_todos", success: false, error: "todo rejected" });
					break;
				}
				todoPhases = frame.phases ?? [];
				respond({ todoPhases });
				break;
			case "get_state":
				respond({ todoPhases });
				break;
			case "set_host_tools":
				respond({ toolNames: [] });
				break;
			case "prompt":
				if (frame.message === "reject") {
					out({ type: "response", id: frame.id, command: "prompt", success: false, error: "prompt rejected" });
					break;
				}
				respond(undefined);
				void runPrompt();
				break;
			default:
				out({
					type: "response",
					id: frame.id,
					command: frame.type,
					success: false,
					error: `unhandled ${frame.type}`,
				});
		}
	}
}

export {};
