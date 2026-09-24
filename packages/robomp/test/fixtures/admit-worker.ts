/** Worker used by db.test.ts to race `admitSubmission` across real connections. */
import { Database, isoSecondsAgo } from "../../src/db";

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ path: string; deliveryId: string; sab: SharedArrayBuffer }>) => {
	const { path, deliveryId, sab } = event.data;
	const database = new Database(path);
	const gate = new Int32Array(sab);
	// Barrier: bump arrival count, then spin until both workers arrived.
	Atomics.add(gate, 0, 1);
	Atomics.notify(gate, 0);
	while (Atomics.load(gate, 0) < 2) Atomics.wait(gate, 0, Atomics.load(gate, 0), 50);
	try {
		const admission = database.admitSubmission({
			delivery_id: deliveryId,
			login: "alice",
			repo: "octo/widget",
			since: isoSecondsAgo(60),
			cap: 1,
		});
		self.postMessage({ accepted: admission.accepted });
	} finally {
		database.close();
	}
};
