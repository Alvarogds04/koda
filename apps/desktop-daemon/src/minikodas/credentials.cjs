"use strict";

/**
 * K2-13 Minikodas (S11, decision «1a»): the credential a Minikoda run uses, and its write-back.
 *
 * A Minikoda runs with a COPY of one account credential in its own private agent dir. An OAuth credential can
 * be refreshed by the engine during the run, and a provider that rotates refresh tokens invalidates the old
 * one: unless the refreshed credential goes back, the chat (or the next run) is signed out. Rules:
 *
 * - Sources. The account store (`<accounts>/<id>/auth.json`, written by the SDK helper) and, when the chat's
 *   active profile uses the same account and provider, the chat engine's live `agent/auth.json` (the chat
 *   refreshes there and saves it back to the account only on a profile switch, so the account copy can be
 *   stale).
 * - Copy-in (`freshestCredential`): the freshest of the two. For OAuth, fresher = larger `expires`. Anything
 *   else (api keys, local placeholders) comes from the account store, which the user edits. The account store
 *   is authoritative about logout: no credential there means not signed in, whatever the chat holds.
 * - Write-back (`writeBackCredential`): after the run, when the Minikoda's OAuth credential changed and is
 *   fresher, it is written to the account store and, when the chat's active profile uses that account, to the
 *   chat's live `agent/auth.json`; each side only when it still holds that provider (logout is never
 *   undone) and only when the written credential is fresher than what it holds NOW (never an older token over
 *   a newer one).
 * - Serialization. Every read and write happens under the lock directories the SDK's file credential store
 *   uses (`<file>.lock`, proper-lockfile: mkdir, stale after 30 s), the same ones ProfileStore takes for
 *   activation. The chat engine's own refresh runs read-modify-write under that lock and reloads the file when
 *   its revision changes, so a write here neither races its refresh nor is missed by it. Lock order is always
 *   chat agent dir, then account dir (ProfileStore and the SDK helper each take only one of them), so it
 *   cannot deadlock. A leftover profile-switch journal makes the chat side unknown: it is then left alone.
 *   Writes are atomic (writePrivateFile: temp file + rename, 0600).
 */

const { lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync } = require("node:fs");
const path = require("node:path");
const { writePrivateFile } = require("../isolation.cjs");

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 20_000; // above the SDK refresh timeout (15 s) a chat refresh may hold the lock for
const ACCOUNT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw error;
	}
	const value = JSON.parse(text);
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("credential store is unreadable");
	return value;
}

const isOauth = (c) => c?.type === "oauth" && typeof c.access === "string" && typeof c.refresh === "string" && Number.isFinite(c.expires);
/** True when `a` is an OAuth credential strictly fresher than `b` (b missing or not OAuth counts as older). */
const fresher = (a, b) => isOauth(a) && (!isOauth(b) || a.expires > b.expires);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Takes `<dir>/auth.json.lock` (the SDK file store's lock), breaking a stale one; returns the release function. */
async function lockCredentials(dir, { waitMs = LOCK_WAIT_MS } = {}) {
	let real = dir;
	try {
		real = realpathSync.native(dir);
	} catch {}
	const lockDir = path.join(real, "auth.json.lock");
	const deadline = Date.now() + waitMs;
	mkdirSync(real, { recursive: true, mode: 0o700 });
	for (;;) {
		try {
			mkdirSync(lockDir, { mode: 0o700 });
			return () => {
				try {
					rmdirSync(lockDir);
				} catch {}
			};
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
		}
		try {
			if (Date.now() - lstatSync(lockDir).mtimeMs > LOCK_STALE_MS) {
				try {
					rmdirSync(lockDir);
				} catch {}
				continue;
			}
		} catch {}
		if (Date.now() > deadline) throw new Error("credential store is locked");
		await sleep(25);
	}
}

/**
 * The chat engine's live credential file for (accountId, provider), or undefined when the chat's active
 * profile is another account/provider, nothing is active, or a profile switch was interrupted (journal left).
 * Call under the chat agent-dir lock.
 */
function chatTarget(chat, accountId, provider) {
	if (!chat?.agentDir || !chat.activeAccountPath) return undefined;
	try {
		lstatSync(path.join(chat.agentDir, ".switch.json"));
		return undefined;
	} catch {}
	let marker;
	try {
		marker = JSON.parse(readFileSync(chat.activeAccountPath, "utf8"));
	} catch {
		return undefined;
	}
	if (marker?.accountId !== accountId || marker?.provider !== provider) return undefined;
	return path.join(chat.agentDir, "auth.json");
}

async function withLocks(chat, accountDir, waitMs, fn) {
	const releaseChat = chat?.agentDir ? await lockCredentials(chat.agentDir, { waitMs }) : () => {};
	try {
		const releaseAccount = await lockCredentials(accountDir, { waitMs });
		try {
			return await fn();
		} finally {
			releaseAccount();
		}
	} finally {
		releaseChat();
	}
}

function accountDirOf(accountsRoot, accountId) {
	if (!ACCOUNT_ID.test(String(accountId))) throw new Error("invalid account id");
	return path.join(accountsRoot, accountId);
}

/**
 * The credential to copy into a Minikoda run: the account's, or the chat's live one when it is the same
 * account and provider and holds a fresher OAuth token. Undefined when the account is not signed in.
 */
async function freshestCredential({ accountsRoot, accountId, provider, chat, lockWaitMs }) {
	const accountDir = accountDirOf(accountsRoot, accountId);
	return withLocks(chat, accountDir, lockWaitMs, async () => {
		const stored = readJson(path.join(accountDir, "auth.json"))[provider];
		if (!stored) return undefined; // logout is authoritative
		const liveFile = chatTarget(chat, accountId, provider);
		let live;
		try {
			live = liveFile ? readJson(liveFile)[provider] : undefined;
		} catch {
			live = undefined; // an unreadable chat file never blocks the run: the account copy is used
		}
		return fresher(live, stored) ? live : stored;
	});
}

/**
 * After a run: writes the Minikoda's refreshed OAuth credential (`after`, which differs from the copied-in
 * `before`) back to the account store and the chat's live file, each only when it still holds the provider
 * and `after` is fresher than what it holds now. Returns {account, chat} booleans (what was written).
 */
async function writeBackCredential({ accountsRoot, accountId, provider, chat, before, after, lockWaitMs }) {
	const written = { account: false, chat: false };
	if (!isOauth(after) || same(after, before)) return written;
	const accountDir = accountDirOf(accountsRoot, accountId);
	return withLocks(chat, accountDir, lockWaitMs, async () => {
		const accountFile = path.join(accountDir, "auth.json");
		const stored = readJson(accountFile);
		if (stored[provider] !== undefined && fresher(after, stored[provider])) {
			writePrivateFile(accountFile, `${JSON.stringify({ ...stored, [provider]: after }, null, 2)}\n`);
			written.account = true;
		}
		const liveFile = chatTarget(chat, accountId, provider);
		if (liveFile) {
			const live = readJson(liveFile);
			if (live[provider] !== undefined && fresher(after, live[provider])) {
				writePrivateFile(liveFile, `${JSON.stringify({ ...live, [provider]: after }, null, 2)}\n`);
				written.chat = true;
			}
		}
		return written;
	});
}

/** The Minikoda's own copy after its run (its engine is stopped by then), or undefined. */
function readRunCredential(agentDir, provider) {
	try {
		return readJson(path.join(agentDir, "auth.json"))[provider];
	} catch {
		return undefined;
	}
}

module.exports = { freshestCredential, writeBackCredential, readRunCredential, lockCredentials, isOauth, fresher, LOCK_STALE_MS };
