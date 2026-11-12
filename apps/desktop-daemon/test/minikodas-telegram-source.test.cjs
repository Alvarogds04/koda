"use strict";

// K2-13 Minikodas, commit 3 (T1b, S6): reading a Telegram channel as a Minikoda's source. Resolve the channel once and
// cache {channelId, accessHash} in the Minikoda's private state, poll only posts newer than the last one seen, download
// the videos (and audio/voice/round media) into the run's private media folder under a size and duration cap read from
// Telegram's own metadata, ignore photos and documents, skip protected media, and move the marker only when the run
// really succeeded. Offline: the client is a scripted fake; no Telegram account is involved.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const {
	TelegramSource,
	parseSource,
	normalizeChannel,
	TelegramSourceError,
	SOURCE_LIMITS,
} = require("../src/minikodas/telegram-source.cjs");
const { MinikodaService } = require("../src/minikodas/service.cjs");
const { validateRecipe } = require("../src/minikodas/recipe.cjs");

const posix = process.platform !== "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return;
		await sleep(10);
	}
	assert.ok(await fn(), "waitFor timed out");
}
function tmp(t) {
	const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "abito-tgsrc-")));
	t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
	return base;
}
const rpc = (text) => Object.assign(new Error(text), { text });

/** One channel post as mtcute hands it over: newest first from getHistory, media typed like `MessageMedia`. */
const post = (id, text, media, extra = {}) => ({ id, text, media, isChannelPost: true, isContentProtected: false, ...extra });
const video = (over = {}) => ({ type: "video", fileSize: 4_000_000, mimeType: "video/mp4", duration: 95, fileName: "clip.mp4", ...over });
const audio = (over = {}) => ({ type: "audio", fileSize: 900_000, mimeType: "audio/mpeg", duration: 210, fileName: "pod.mp3", ...over });
const voice = (over = {}) => ({ type: "voice", fileSize: 90_000, mimeType: "audio/ogg", duration: 12, ...over });
const photo = () => ({ type: "photo", fileSize: 20_000, mimeType: "image/jpeg" });
const document = () => ({ type: "document", fileSize: 2_000, mimeType: "application/pdf" });

/**
 * A scripted stand-in for the live mtcute client: records every call and hands back what the test scripted. Downloads
 * are Node Readables, like the real `downloadAsNodeStream`, so the reader must consume a stream (not a Buffer).
 */
function fakeClient(script = {}) {
	const calls = { resolve: [], history: [], messages: [], downloads: [] };
	const client = {
		calls,
		async resolveChannel(name) {
			calls.resolve.push(name);
			if (script.resolveError) throw rpc(script.resolveError);
			return { _: "inputChannel", channelId: script.channelId ?? 4242, accessHash: String(script.accessHash ?? 7777) };
		},
		async getHistory(peer, params) {
			calls.history.push({ peer, params });
			if (script.historyError) throw rpc(script.historyError);
			return script.messages ?? [];
		},
		async getMessages(peer, ids) {
			calls.messages.push({ peer, ids });
			if (script.refetchError) throw rpc(script.refetchError);
			return script.refetched ?? [];
		},
		downloadAsNodeStream(location, params) {
			calls.downloads.push({ location, params });
			const step = script.downloads ?? [];
			const next = step[calls.downloads.length - 1] ?? { bytes: 1024 };
			if (next.error) {
				return new Readable({
					read() {
						this.destroy(rpc(next.error));
					},
				});
			}
			const size = next.bytes ?? 1024;
			let sent = false;
			return new Readable({
				read() {
					if (sent) {
						this.push(null);
						return;
					}
					sent = true;
					this.push(Buffer.alloc(size, 7));
					this.push(null);
				},
			});
		},
	};
	return client;
}

function source(t, options = {}) {
	const base = options.base ?? tmp(t);
	const src = new TelegramSource({
		stateDir: path.join(base, "island", "minikodas", "telegram"),
		mediaRoot: path.join(base, "island", "minikodas", "media"),
		getClient: options.getClient ?? (() => options.client ?? fakeClient(options.script)),
		log: options.log,
		now: options.now,
	});
	return { src, base };
}
const recipeWith = (channel) => validateRecipe({
	id: "canal",
	name: "Canal",
	when: { manual: true },
	reads: { source: `telegram:${channel}` },
	kit: ["source_read", "inbox_propose"],
	prompt: "Sos un Minikoda de oportunidades.",
	model: { provider: "fake", id: "fake-minikoda", accountId: "main" },
	never: ["buy", "sell", "send", "delete"],
});

// ---------- the source descriptor ----------

test("source: a channel is @name or a t.me link, and nothing else", () => {
	for (const value of ["@valmar_canal", "valmar_canal", "t.me/valmar_canal", "https://t.me/valmar_canal", "http://telegram.me/valmar_canal/", "https://www.t.me/valmar_canal"]) {
		assert.equal(normalizeChannel(value), "@valmar_canal", value);
	}
	for (const value of ["@abc", "ab", "@val-mar", "t.me/+AbCdEf123", "t.me/joinchat/AbCdEf", "t.me/c/1234567890/42", "https://t.me/valmar/s/12", "https://example.com/valmar", "@valmar?x=1", "a".repeat(33), "@valmar canal"]) {
		assert.equal(normalizeChannel(value), undefined, `refused: ${value}`);
	}
	assert.deepEqual(parseSource("telegram:@valmar_canal"), { type: "telegram", channel: "@valmar_canal" });
	assert.deepEqual(parseSource("telegram:t.me/valmar_canal"), { type: "telegram", channel: "@valmar_canal" });
	assert.deepEqual(parseSource("mi archivo de notas"), { type: "text" }, "a plain descriptor stays a text source");
	assert.equal(parseSource("telegram:"), undefined, "an empty telegram marker is a broken descriptor, never a text source");
	assert.equal(parseSource("telegram:@bad name"), undefined, "a malformed channel is refused, never repaired");
});

// ---------- resolve once, poll what is new ----------

test("source: the channel is resolved once and cached (0600) in the Minikoda's private state; the next run reuses it", async (t) => {
	const client = fakeClient({ messages: [post(3, "tercero")] });
	const { src, base } = source(t, { client });
	const stateFile = path.join(base, "island", "minikodas", "telegram", "canal.json");
	const first = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "run-1" });
	assert.match(first.text, /tercero/);
	assert.equal(client.calls.resolve.length, 1, "resolveChannel was called once");
	assert.deepEqual(client.calls.history[0].peer, { _: "inputChannel", channelId: 4242, accessHash: "7777" }, "the resolved channel is the peer");
	const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
	assert.deepEqual(state, { version: 1, channel: "@valmar_canal", channelId: 4242, accessHash: "7777", lastSeenId: 0 });
	if (posix) assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600, "the state is private");
	await first.commit();
	assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).lastSeenId, 3, "the marker moves after a successful run");
	const second = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "run-2" });
	assert.equal(client.calls.resolve.length, 1, "the cached channel is reused, never resolved twice");
	assert.deepEqual(client.calls.history[1].peer, { _: "inputPeerChannel", channelId: 4242, accessHash: "7777" }, "the cached channel is an input peer");
	assert.equal(client.calls.history[1].params.minId, 3, "only posts newer than the last one seen");
	assert.match(second.text, /tercero/);
});

test("source: the first run reads the latest 5 posts, later runs at most 20", async (t) => {
	const client = fakeClient({ messages: [post(1, "uno")] });
	const { src } = source(t, { client });
	await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r1" });
	assert.equal(client.calls.history[0].params.limit, SOURCE_LIMITS.firstRunPosts);
	assert.equal(SOURCE_LIMITS.firstRunPosts, 5);
	const committed = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r2" });
	await committed.commit();
	const again = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r3" });
	await again.commit();
	assert.equal(client.calls.history[2].params.limit, SOURCE_LIMITS.maxPostsPerRun);
	assert.equal(SOURCE_LIMITS.maxPostsPerRun, 20);
});

test("source: the marker moves only after commit(), so a failed run reads the same posts again", async (t) => {
	const client = fakeClient({ messages: [post(9, "nueve")] });
	const { src } = source(t, { client });
	await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r1" }); // no commit: the run failed
	const again = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r2" });
	assert.equal(client.calls.history[1].params.minId, undefined, "nothing was marked as seen");
	assert.match(again.text, /nueve/);
});

test("source: posts come oldest → newest with their id, and a channel with nothing new says so", async (t) => {
	const client = fakeClient({ messages: [post(12, "doce"), post(11, "once"), post(10, "diez")] });
	const { src } = source(t, { client });
	const out = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r1" });
	assert.ok(out.text.indexOf("diez") < out.text.indexOf("once"), "oldest first, so the Minikoda reads chronologically");
	assert.ok(out.text.indexOf("once") < out.text.indexOf("doce"));
	assert.match(out.text, /10/);
	assert.match(out.text, /12/);
	assert.match(out.text, /@valmar_canal/);
	const empty = fakeClient({ messages: [] });
	const silent = source(t, { client: empty, base: tmp(t) });
	const none = await silent.src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r1" });
	assert.match(none.text, /sin publicaciones nuevas/i);
});

// ---------- media ----------

test("source: video, audio, voice and round video are downloaded into the run's private media folder with their metadata", async (t) => {
	const round = { ...video({ duration: 8, fileSize: 300_000, mimeType: "video/mp4" }), isRound: true };
	const client = fakeClient({
		messages: [
			post(5, "el video", video()),
			post(4, "el audio", audio()),
			post(3, "la nota de voz", voice()),
			post(2, "el video redondo", round),
			post(1, "solo texto"),
		],
	});
	const { src, base } = source(t, { client });
	const out = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "run-media" });
	assert.equal(out.media.length, 4);
	// posts are read oldest first, so the round video (post 2) comes before the voice note, the audio and the video
	assert.deepEqual(out.media.map((m) => m.mimeType), ["video/mp4", "audio/ogg", "audio/mpeg", "video/mp4"]);
	assert.deepEqual(out.media.map((m) => m.durationSec), [8, 12, 210, 95]);
	assert.deepEqual(out.media.map((m) => m.messageId), [2, 3, 4, 5]);
	const mediaDir = path.join(base, "island", "minikodas", "media", "run-media");
	for (const entry of out.media) {
		assert.equal(path.dirname(path.dirname(path.dirname(path.dirname(path.dirname(entry.path))))), base, "the media stay inside the island root");
		assert.ok(entry.path.startsWith(path.join(base, "island", "minikodas", "media") + path.sep), "under minikodas/media");
		assert.equal(path.dirname(entry.path), mediaDir, "one folder per run");
		assert.ok(fs.existsSync(entry.path), `downloaded: ${entry.path}`);
		assert.ok(fs.statSync(entry.path).size > 0);
	}
	if (posix) {
		assert.equal(fs.statSync(mediaDir).mode & 0o777, 0o700, "the media folder is private");
		assert.equal(fs.statSync(out.media[0].path).mode & 0o777, 0o600, "each media file is private");
	}
	assert.equal(client.calls.downloads.length, 4);
	assert.match(out.text, /video/i, "the text tells the Minikoda that the post carries media");
});

test("source: photos and documents are ignored, never downloaded", async (t) => {
	const client = fakeClient({ messages: [post(2, "una foto", photo()), post(1, "un pdf", document())] });
	const { src } = source(t, { client });
	const out = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r" });
	assert.deepEqual(out.media, []);
	assert.equal(client.calls.downloads.length, 0);
	assert.match(out.text, /una foto/);
	assert.match(out.text, /un pdf/);
});

test("source: a video over 200 MB or over 3 hours is refused BEFORE any download, with a note in the text", async (t) => {
	const client = fakeClient({
		messages: [
			post(3, "demasiado pesado", video({ fileSize: SOURCE_LIMITS.maxMediaBytes + 1 })),
			post(2, "demasiado largo", video({ fileSize: 5_000_000, duration: SOURCE_LIMITS.maxMediaDurationSec + 1 })),
			post(1, "no dice el tamaño", video({ fileSize: undefined })),
		],
	});
	const { src } = source(t, { client });
	const out = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r" });
	assert.deepEqual(out.media, []);
	assert.equal(client.calls.downloads.length, 0, "the metadata alone refuses them");
	assert.equal(SOURCE_LIMITS.maxMediaBytes, 200 * 1024 * 1024);
	assert.equal(SOURCE_LIMITS.maxMediaDurationSec, 3 * 60 * 60);
	assert.match(out.text, /demasiado (pesado|grande)/i);
	assert.match(out.text, /largo/i);
	assert.doesNotMatch(out.text, /no dice el tamaño[\s\S]*video descargado/i);
});

test("source: protected content (noforwards) is skipped with a note instead of downloaded", async (t) => {
	const client = fakeClient({ messages: [post(1, "contenido protegido", video(), { isContentProtected: true })] });
	const { src } = source(t, { client });
	const out = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r" });
	assert.deepEqual(out.media, []);
	assert.equal(client.calls.downloads.length, 0);
	assert.match(out.text, /protegid|sin reenvío/i);
});

test("source: FILE_REFERENCE_EXPIRED refetches the message once and finishes the download", async (t) => {
	const client = fakeClient({
		messages: [post(7, "el video", video())],
		downloads: [{ error: "FILE_REFERENCE_EXPIRED" }, { bytes: 2048 }],
		refetched: [post(7, "el video", video())],
	});
	const { src } = source(t, { client });
	const out = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r" });
	assert.equal(out.media.length, 1);
	assert.equal(client.calls.messages.length, 1, "the message was refetched exactly once");
	assert.deepEqual(client.calls.messages[0].ids, [7]);
	assert.equal(client.calls.downloads.length, 2, "one retry, not a loop");
});

test("source: FILE_REFERENCE_EXPIRED twice is an error, never an endless retry", async (t) => {
	const client = fakeClient({
		messages: [post(7, "el video", video())],
		downloads: [{ error: "FILE_REFERENCE_EXPIRED" }, { error: "FILE_REFERENCE_EXPIRED" }],
		refetched: [post(7, "el video", video())],
	});
	const { src } = source(t, { client });
	await assert.rejects(() => src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r" }), (error) => error.code === "telegram_failed");
	assert.equal(client.calls.downloads.length, 2);
});

// ---------- channel/account failures ----------

test("source: a long FLOOD_WAIT is one closed error with the minutes, never a retry loop", async (t) => {
	const client = fakeClient({ historyError: "FLOOD_WAIT_300" });
	const { src } = source(t, { client });
	await assert.rejects(
		() => src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r" }),
		(error) => {
			assert.equal(error.code, "telegram_flood_wait");
			assert.equal(error.retryAfterMinutes, 5);
			assert.equal(error.notice, "Telegram pidió esperar 5 minutos.");
			return true;
		},
	);
	assert.equal(client.calls.history.length, 1, "no retry");
});

test("source: without a connected Telegram account the source refuses instead of running blind", async (t) => {
	const { src } = source(t, { getClient: () => undefined });
	await assert.rejects(
		() => src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r" }),
		(error) => {
			assert.ok(error instanceof TelegramSourceError, "the session's closed error type");
			assert.equal(error.code, "telegram_not_connected");
			assert.match(error.notice, /Telegram/i, "«Hoy» gets a Spanish sentence");
			return true;
		},
	);
});

test("source: a cached channel that Telegram no longer accepts is resolved again once", async (t) => {
	const base = tmp(t);
	fs.mkdirSync(path.join(base, "island", "minikodas", "telegram"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(base, "island", "minikodas", "telegram", "canal.json"), JSON.stringify({ version: 1, channel: "@valmar_canal", channelId: 1, accessHash: "2", lastSeenId: 0 }), { mode: 0o600 });
	const client = fakeClient({ messages: [post(4, "nuevo")] });
	let first = true;
	const history = client.getHistory.bind(client);
	client.getHistory = async (peer, params) => {
		if (first) {
			first = false;
			throw rpc("CHANNEL_INVALID");
		}
		return history(peer, params);
	};
	const { src } = source(t, { client, base });
	const out = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r" });
	assert.match(out.text, /nuevo/);
	assert.equal(client.calls.resolve.length, 1, "the stale cache was refreshed once");
});

test("source: the media live under the island's minikodas/media/<run>, and a second run gets its own folder", async (t) => {
	const base = tmp(t);
	const client = fakeClient({ messages: [post(1, "v", video())] });
	const { src } = source(t, { client, base });
	const one = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "run-a" });
	const two = await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "run-b" });
	assert.notEqual(one.media[0].path, two.media[0].path);
	assert.equal(path.basename(path.dirname(one.media[0].path)), "run-a");
	assert.equal(path.basename(path.dirname(two.media[0].path)), "run-b");
});

test("source: nothing secret is logged (no channel access hash, no message text)", async (t) => {
	const lines = [];
	const client = fakeClient({ messages: [post(1, "texto confidencial", video())] });
	const { src } = source(t, { client, log: (line) => lines.push(line) });
	await src.prepare({ recipe: recipeWith("@valmar_canal"), runId: "r" });
	assert.ok(lines.length > 0, "the reader says what it did");
	for (const line of lines) {
		assert.doesNotMatch(line, /7777|texto confidencial/, `leaked: ${line}`);
	}
});

// ---------- the service turns a source failure into «Hoy» ----------

function accountsFixture(base) {
	const accountsRoot = path.join(base, "accounts");
	fs.mkdirSync(path.join(accountsRoot, "main"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(accountsRoot, "main", "auth.json"), JSON.stringify({ fake: { type: "api_key", key: "FAKE-KEY-NOT-REAL" } }), { mode: 0o600 });
	fs.writeFileSync(path.join(accountsRoot, "main", "models.json"), JSON.stringify({ providers: { fake: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "fake-minikoda" }] } } }), { mode: 0o600 });
	const accounts = [{ accountId: "main", provider: "fake", configured: true }];
	return {
		accountsRoot,
		accounts: { listAccounts: () => accounts.map((a) => ({ ...a })), models: async (provider) => (provider === "fake" ? [{ provider: "fake", id: "fake-minikoda" }] : []) },
		profiles: { list: () => ({ profiles: [{ id: "work", accountId: "main", provider: "fake", modelId: "fake-minikoda" }], active: "work" }) },
	};
}

test("service: a Minikoda that reads a Telegram channel lands a Spanish «Hoy» error while no account is connected", async (t) => {
	const base = tmp(t);
	const fx = accountsFixture(base);
	const results = { runs: [], errors: [], addRun: async (run) => results.runs.push(run), addError: async (err) => results.errors.push(err) };
	const svc = new MinikodaService({
		islandRoot: path.join(base, "island"),
		accounts: fx.accounts,
		profiles: fx.profiles,
		accountsRoot: fx.accountsRoot,
		results,
		minEveryMs: 1,
		runTimeoutMs: 10_000,
		telegram: { connectedClient: () => undefined },
		engine: { command: process.execPath, commandArgs: ["-e", "process.exit(0)"], env: { PATH: process.env.PATH }, startTimeoutMs: 5_000 },
	});
	t.after(() => svc.stop());
	svc.start();
	const draft = await svc.createDraft({
		name: "Canal",
		when: { manual: true },
		reads: { source: "telegram:@valmar_canal" },
		kit: ["source_read"],
		prompt: "Sos un Minikoda de oportunidades.",
		never: ["buy", "sell", "send", "delete"],
	});
	await svc.approveCreate(draft.id);
	await svc.launch(draft.id);
	await waitFor(() => results.errors.length === 1);
	assert.equal(results.runs.length, 0);
	assert.match(results.errors[0].text, /Telegram/, "«Hoy» explains it in Spanish");
	assert.doesNotMatch(results.errors[0].text, /accessHash|7777/);
	assert.equal(svc.find(draft.id).lastRun.outcome, "failed");
	assert.equal(svc.find(draft.id).lastRun.reason, "source");
});
