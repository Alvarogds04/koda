"use strict";

// K2-05 attachments (L11 2a): the daemon-side upload store (port of Gentle Dot's
// packages/daemon/src/uploads.ts, MIT). Files reach the daemon over the authenticated
// island channel, are stored in the ENGINE WORKSPACE (`<workspace>/uploads/<id>/<name>`),
// and a message refers to them only by the opaque id the daemon issued to that client.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
	UploadStore,
	ATTACHMENT_LIMITS,
	MAX_IMAGE_BYTES,
	UPLOAD_ID,
	sanitizeName,
	sniffMime,
	composePrompt,
	readStored,
} = require("../src/uploads.cjs");
const { splitAttachments } = require("../src/conversations.cjs");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);

function workspace(t) {
	const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "abito-uploads-"));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** One whole file in one chunk. */
function put(store, owner, name, bytes, requestId = `r${Math.random().toString(36).slice(2, 10)}`) {
	return store.receive(owner, { requestId, name, size: bytes.length, offset: 0, data: bytes });
}

test("sanitizeName: last segment only, no traversal, hidden marks or reserved names", () => {
	assert.equal(sanitizeName("../../etc/passwd"), "passwd");
	assert.equal(sanitizeName("C:\\Users\\x\\..\\secreto.txt"), "secreto.txt");
	assert.equal(sanitizeName(".bashrc"), "bashrc");
	assert.equal(sanitizeName("..."), "file");
	assert.equal(sanitizeName(""), "file");
	assert.equal(sanitizeName("con.txt"), "file.txt");
	assert.equal(sanitizeName("a\u202eexe.txt"), "aexe.txt", "direction marks removed");
	assert.equal(sanitizeName("a<b>:c|d?.txt"), "a_b__c_d_.txt");
	assert.ok(sanitizeName(`${"x".repeat(300)}.pdf`).length <= 120);
	assert.ok(sanitizeName(`${"x".repeat(300)}.pdf`).endsWith(".pdf"));
});

/** True when the text has no lone surrogate (half of an emoji). */
const wellFormed = (text) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

test("sanitizeName (F-3): a long emoji or CJK name is cut on whole characters, never half an emoji", () => {
	for (const stem of ["😀".repeat(200), `x${"😀".repeat(200)}`, "文".repeat(300), `a${"👩‍👩‍👧".repeat(60)}`]) {
		const name = sanitizeName(`${stem}.png`);
		assert.ok(wellFormed(name), `no lone surrogate: ${JSON.stringify(name.slice(-8))}`);
		assert.ok(name.endsWith(".png"), name);
		assert.ok(name.length <= 120, `at most 120 UTF-16 units: ${name.length}`);
		assert.ok(Buffer.byteLength(name, "utf8") <= 240, `fits a file name on disk: ${Buffer.byteLength(name, "utf8")} bytes`);
	}
	assert.ok(wellFormed(sanitizeName("a\ud800b\udc00c.txt")), "a lone surrogate from the wire is dropped");
	assert.equal(sanitizeName("a\ud800b\udc00c.txt"), "abc.txt");
});

test("F-3: a long emoji name is valid text on disk and in the prompt", (t) => {
	const ws = workspace(t);
	const store = new UploadStore({ workspace: () => ws });
	const owner = {};
	const out = put(store, owner, `${"x"}${"😀".repeat(200)}.png`, PNG);
	assert.equal(out.ok, true, JSON.stringify(out));
	assert.ok(wellFormed(out.file.name));
	const [entry] = fs.readdirSync(path.join(ws, "uploads", out.file.id));
	assert.equal(entry, out.file.name, "the name on disk is the name shown");
	const files = store.resolve(owner, [out.file.id]).files;
	const prompt = composePrompt("mirá", files, { images: false });
	assert.ok(wellFormed(prompt.message));
	assert.ok(!prompt.message.includes("\\ud8"), "no escaped half surrogate reaches the provider");
});

test("sniffMime: images and PDF by content, anything else octet-stream", () => {
	assert.equal(sniffMime(PNG), "image/png");
	assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	assert.equal(sniffMime(Buffer.from("GIF89a....")), "image/gif");
	assert.equal(sniffMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
	assert.equal(sniffMime(Buffer.from("%PDF-1.7")), "application/pdf");
	assert.equal(sniffMime(Buffer.from("hola")), "application/octet-stream");
});

test("receive: a file is stored in the engine workspace under an opaque daemon id, private", (t) => {
	const ws = workspace(t);
	const store = new UploadStore({ workspace: () => ws });
	const owner = {};
	const out = put(store, owner, "../informe final.txt", Buffer.from("hola"));
	assert.equal(out.ok, true);
	assert.equal(out.done, true);
	assert.match(out.file.id, UPLOAD_ID);
	assert.deepEqual({ name: out.file.name, size: out.file.size, mime: out.file.mime }, { name: "informe final.txt", size: 4, mime: "application/octet-stream" });
	const stored = path.join(ws, "uploads", out.file.id, "informe final.txt");
	assert.equal(fs.readFileSync(stored, "utf8"), "hola");
	assert.ok(!("path" in out.file), "the store's path never travels to a client");
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(stored).mode & 0o777, 0o600);
		assert.equal(fs.statSync(path.dirname(stored)).mode & 0o777, 0o700);
		assert.equal(fs.statSync(path.join(ws, "uploads")).mode & 0o777, 0o700);
	}
});

test("receive: chunks in order build the file; a wrong offset or a mismatched header is refused and leaves nothing", (t) => {
	const ws = workspace(t);
	const store = new UploadStore({ workspace: () => ws });
	const owner = {};
	const head = { requestId: "up-1", name: "foto.png", size: PNG.length };
	assert.deepEqual(store.receive(owner, { ...head, offset: 0, data: PNG.subarray(0, 6) }), { ok: true, done: false });
	const done = store.receive(owner, { ...head, offset: 6, data: PNG.subarray(6) });
	assert.equal(done.done, true);
	assert.equal(done.file.mime, "image/png");
	assert.equal(done.file.size, PNG.length);

	const other = { requestId: "up-2", name: "b.bin", size: 10 };
	assert.equal(store.receive(owner, { ...other, offset: 0, data: Buffer.alloc(4) }).ok, true);
	assert.deepEqual(store.receive(owner, { ...other, offset: 3, data: Buffer.alloc(2) }), { ok: false, code: "bad_request" });
	assert.deepEqual(store.receive(owner, { ...other, offset: 4, data: Buffer.alloc(2) }), { ok: false, code: "upload_failed" }, "the refused upload is gone");
	const third = { requestId: "up-3", name: "c.bin", size: 4 };
	assert.equal(store.receive(owner, { ...third, offset: 0, data: Buffer.alloc(2) }).ok, true);
	assert.deepEqual(store.receive(owner, { ...third, name: "otro.bin", offset: 2, data: Buffer.alloc(2) }), { ok: false, code: "bad_request" });
	assert.deepEqual(store.receive(owner, { ...third, offset: 2, data: Buffer.alloc(3) }).ok, false, "more bytes than declared");
	// only the finished png folder is left
	assert.deepEqual(fs.readdirSync(path.join(ws, "uploads")), [done.file.id]);
});

test("limits: the files a client may hold unsent are the 5 per message the island page says («hasta 5»)", (t) => {
	const ws = workspace(t);
	const store = new UploadStore({ workspace: () => ws });
	assert.equal(ATTACHMENT_LIMITS.files, 5);
	const a = {};
	for (let i = 0; i < 5; i += 1) assert.equal(put(store, a, `${i}.txt`, Buffer.from("x")).ok, true);
	assert.deepEqual(put(store, a, "6.txt", Buffer.from("x")), { ok: false, code: "too_many_files" }, "the sixth is refused");
});

test("limits: a file over 25 MB is refused before a byte is written", (t) => {
	const ws = workspace(t);
	const store = new UploadStore({ workspace: () => ws });
	assert.equal(ATTACHMENT_LIMITS.fileBytes, 25 * 1024 * 1024);
	const out = store.receive({}, { requestId: "big", name: "big.bin", size: ATTACHMENT_LIMITS.fileBytes + 1, offset: 0, data: Buffer.alloc(1) });
	assert.deepEqual(out, { ok: false, code: "file_too_large" });
	assert.equal(fs.existsSync(path.join(ws, "uploads")), false);
});

test("quota per client: files and bytes waiting to be sent are bounded; another client has its own", (t) => {
	const ws = workspace(t);
	const store = new UploadStore({ workspace: () => ws, limits: { fileBytes: 10, messageBytes: 16, files: 3 } });
	const a = {};
	const b = {};
	assert.equal(put(store, a, "1.txt", Buffer.alloc(8)).ok, true);
	assert.deepEqual(put(store, a, "2.txt", Buffer.alloc(9)), { ok: false, code: "message_too_large" });
	assert.equal(put(store, a, "2.txt", Buffer.alloc(4)).ok, true);
	assert.equal(put(store, a, "3.txt", Buffer.alloc(1)).ok, true);
	assert.deepEqual(put(store, a, "4.txt", Buffer.alloc(1)), { ok: false, code: "too_many_files" });
	assert.equal(put(store, b, "1.txt", Buffer.alloc(8)).ok, true, "the quota is per client");
	// an upload in progress reserves its declared size
	const c = {};
	assert.equal(store.receive(c, { requestId: "p", name: "p.bin", size: 10, offset: 0, data: Buffer.alloc(1) }).ok, true);
	assert.deepEqual(put(store, c, "q.txt", Buffer.alloc(7)), { ok: false, code: "message_too_large" });
});

test("refs: only the client the id was issued to may use it, once; unknown ids are refused", (t) => {
	const ws = workspace(t);
	const store = new UploadStore({ workspace: () => ws });
	const a = {};
	const b = {};
	const { file } = put(store, a, "nota.txt", Buffer.from("x"));
	assert.deepEqual(store.resolve(b, [file.id]), { ok: false, code: "attachment_not_found" }, "another client's ref is refused");
	assert.deepEqual(store.resolve(a, ["a-0000000000000000"]), { ok: false, code: "attachment_not_found" });
	assert.deepEqual(store.resolve(a, [file.id, file.id]), { ok: false, code: "attachment_not_found" }, "the same ref twice");
	const ok = store.resolve(a, [file.id]);
	assert.equal(ok.ok, true);
	assert.equal(ok.files[0].path, path.join(ws, "uploads", file.id, "nota.txt"));
	store.consume(a, [file.id]);
	assert.deepEqual(store.resolve(a, [file.id]), { ok: false, code: "attachment_not_found" }, "a ref is used once");
	assert.ok(fs.existsSync(ok.files[0].path), "a sent file stays for the agent");
	assert.equal(put(store, a, "x.txt", Buffer.from("y")).ok, true, "a sent file no longer counts against the quota");
});

test("cleanup: discard, a client going away and the one-hour expiry remove unsent files only", (t) => {
	const ws = workspace(t);
	let clock = 1_000;
	const store = new UploadStore({ workspace: () => ws, now: () => clock });
	const a = {};
	const b = {};
	const one = put(store, a, "uno.txt", Buffer.from("1")).file;
	const sent = put(store, a, "dos.txt", Buffer.from("2")).file;
	const theirs = put(store, b, "tres.txt", Buffer.from("3")).file;
	store.consume(a, [sent.id]);
	assert.equal(store.discard(b, one.id), false, "another client cannot discard it");
	assert.equal(store.discard(a, one.id), true);
	assert.equal(fs.existsSync(path.join(ws, "uploads", one.id)), false);
	const partial = store.receive(a, { requestId: "half", name: "h.bin", size: 4, offset: 0, data: Buffer.alloc(1) });
	assert.equal(partial.ok, true);
	const left = put(store, a, "cuatro.txt", Buffer.from("4")).file;
	store.dropOwner(a);
	assert.equal(fs.existsSync(path.join(ws, "uploads", left.id)), false, "unsent: removed with its client");
	assert.equal(fs.existsSync(path.join(ws, "uploads", sent.id, "dos.txt")), true, "sent: kept for the agent");
	assert.deepEqual(fs.readdirSync(path.join(ws, "uploads")).sort(), [sent.id, theirs.id].sort(), "the partial upload is gone too");
	clock += 60 * 60 * 1000 + 1;
	put(store, {}, "trigger.txt", Buffer.from("t"));
	assert.equal(fs.existsSync(path.join(ws, "uploads", theirs.id)), false, "an upload never sent expires after an hour");
	assert.equal(fs.existsSync(path.join(ws, "uploads", sent.id, "dos.txt")), true);
});

test("an upload idle for two minutes is dropped and frees the quota", (t) => {
	const ws = workspace(t);
	let clock = 0;
	const store = new UploadStore({ workspace: () => ws, now: () => clock, limits: { fileBytes: 10, messageBytes: 10, files: 1 } });
	const a = {};
	assert.equal(store.receive(a, { requestId: "slow", name: "s.bin", size: 10, offset: 0, data: Buffer.alloc(1) }).ok, true);
	assert.deepEqual(put(store, a, "n.txt", Buffer.alloc(1)), { ok: false, code: "too_many_files" });
	clock += 2 * 60 * 1000 + 1;
	assert.equal(put(store, a, "n.txt", Buffer.alloc(1)).ok, true);
	assert.deepEqual(store.receive(a, { requestId: "slow", name: "s.bin", size: 10, offset: 1, data: Buffer.alloc(1) }), { ok: false, code: "upload_failed" });
});

test("a planted link instead of the uploads folder is refused, nothing is written through it", { skip: process.platform === "win32" }, (t) => {
	const ws = workspace(t);
	const outside = workspace(t);
	fs.symlinkSync(outside, path.join(ws, "uploads"));
	const store = new UploadStore({ workspace: () => ws });
	assert.deepEqual(put(store, {}, "a.txt", Buffer.from("x")), { ok: false, code: "upload_failed" });
	assert.deepEqual(fs.readdirSync(outside), []);
});

test("no workspace: uploads are refused", () => {
	const store = new UploadStore({ workspace: () => undefined });
	assert.deepEqual(put(store, {}, "a.txt", Buffer.from("x")), { ok: false, code: "upload_failed" });
});

test("composePrompt: Gentle Dot's block; images inline only for a vision model; round-trips through splitAttachments", () => {
	const files = [
		{ name: "foto.png", size: 3, mime: "image/png", path: "/ws/uploads/a-1/foto.png" },
		{ name: "datos.csv", size: 5, mime: "application/octet-stream", path: "/ws/uploads/a-2/datos.csv" },
	];
	const read = (p) => Buffer.from(p.endsWith(".png") ? "PNG" : "nope");
	const vision = composePrompt("mirá esto", files, { images: true, read });
	assert.deepEqual(vision.images, [{ type: "image", mimeType: "image/png", data: Buffer.from("PNG").toString("base64") }]);
	assert.match(vision.message, /^mirá esto\n\n<attachments>\nThe user attached these files, saved in your workspace\. Read them with your tools when needed\.\n/);
	assert.match(vision.message, /"path":"\/ws\/uploads\/a-2\/datos\.csv"/);
	assert.match(vision.message, /"image":"attached to this message"/);
	assert.deepEqual(splitAttachments(vision.message), {
		text: "mirá esto",
		attachments: [{ name: "foto.png", size: 3, mime: "image/png" }, { name: "datos.csv", size: 5, mime: "application/octet-stream" }],
	});
	const blind = composePrompt("", files, { images: false, read });
	assert.equal(blind.images, undefined);
	assert.match(blind.message, /^<attachments>\n/);
	assert.match(blind.message, /the current model cannot see images/);
	assert.equal(splitAttachments(blind.message).text, "");
	const big = composePrompt("x", [{ ...files[0], size: MAX_IMAGE_BYTES + 1 }], { images: true, read });
	assert.equal(big.images, undefined);
	assert.match(big.message, /too large to show you/);
	const unreadable = composePrompt("x", [files[0]], { images: true, read: () => { throw new Error("gone"); } });
	assert.equal(unreadable.images, undefined, "an image that cannot be read is not inlined");
});

test("readStored reads the stored file only: a swapped link or a changed size is refused", { skip: process.platform === "win32" }, (t) => {
	const ws = workspace(t);
	const store = new UploadStore({ workspace: () => ws });
	const owner = {};
	const { file } = put(store, owner, "foto.png", PNG);
	const [stored] = store.resolve(owner, [file.id]).files;
	assert.deepEqual(readStored(stored), PNG);
	const secret = path.join(workspace(t), "secret");
	fs.writeFileSync(secret, "S".repeat(PNG.length));
	fs.rmSync(stored.path);
	fs.symlinkSync(secret, stored.path);
	assert.throws(() => readStored(stored));
	fs.rmSync(stored.path);
	fs.writeFileSync(stored.path, "short");
	assert.throws(() => readStored(stored));
});

test("F-1: readStored refuses a swapped a- folder (a link to another folder with the same file)", { skip: process.platform === "win32" }, (t) => {
	const ws = workspace(t);
	const store = new UploadStore({ workspace: () => ws });
	const owner = {};
	const { file } = put(store, owner, "foto.png", PNG);
	const [stored] = store.resolve(owner, [file.id]).files;
	const outside = workspace(t);
	fs.writeFileSync(path.join(outside, "foto.png"), Buffer.alloc(PNG.length, 0x53));
	fs.renameSync(path.dirname(stored.path), path.join(ws, "moved"));
	fs.symlinkSync(outside, path.dirname(stored.path));
	assert.throws(() => readStored(stored), "never read through a linked a- folder");
	const prompt = composePrompt("x", [stored], { images: true });
	assert.equal(prompt.images, undefined, "nothing outside the uploads folder is inlined");
});

test("F-1: readStored refuses a hardlinked file (nlink > 1): it is never read back inline", (t) => {
	const ws = workspace(t);
	const store = new UploadStore({ workspace: () => ws });
	const owner = {};
	const { file } = put(store, owner, "foto.png", PNG);
	const [stored] = store.resolve(owner, [file.id]).files;
	const secret = path.join(workspace(t), "secret");
	fs.writeFileSync(secret, Buffer.alloc(PNG.length, 0x53));
	fs.rmSync(stored.path);
	fs.linkSync(secret, stored.path);
	assert.throws(() => readStored(stored));
	assert.equal(composePrompt("x", [stored], { images: true }).images, undefined);
});

test("F-1: discard never deletes through a swapped a- folder; the file outside survives", { skip: process.platform === "win32" }, (t) => {
	const ws = workspace(t);
	const store = new UploadStore({ workspace: () => ws });
	const owner = {};
	const { file } = put(store, owner, "nota.txt", Buffer.from("x"));
	const dir = path.join(ws, "uploads", file.id);
	const outside = workspace(t);
	fs.writeFileSync(path.join(outside, "nota.txt"), "keep me");
	fs.renameSync(dir, path.join(ws, "moved"));
	fs.symlinkSync(outside, dir);
	assert.equal(store.discard(owner, file.id), true, "the id is forgotten");
	assert.equal(fs.readFileSync(path.join(outside, "nota.txt"), "utf8"), "keep me");
	assert.equal(store.resolve(owner, [file.id]).ok, false);
});
