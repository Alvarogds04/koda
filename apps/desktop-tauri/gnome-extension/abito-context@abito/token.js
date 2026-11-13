// The one thing that identifies Koda to its own GNOME extension: a random token, made fresh on
// every launch, kept in memory on both sides and never written anywhere (Gentle Dot does the same
// with its local server's token, computer/server.rs).
//
// WHY a token and not a process name: the session bus belongs to the user, so any program running as
// this user could call CaptureWindow. Looking at the caller's command line was a guess: a process can
// be named «koda», and an unreadable command line had to be treated as trusted. The token is not a
// guess. Koda registers it once, the extension binds it to the registering D-Bus unique name, and
// every PickWindow/CaptureWindow must present it.
//
// First caller wins: a program that registers before Koda holds the extension until it leaves the
// bus (Koda's own launch then gets a clear "another program holds Koda's GNOME extension" instead of
// a silent success). That is a denial of service, never a way in: the token itself still cannot be
// guessed, and a same-user program can already read the screen without Koda's help.
//
// Pure JavaScript on purpose: it imports nothing from the GNOME Shell, so this file is
// unit-testable outside a session (a Rust test runs it with node).

/** A token shorter than this is not worth calling random: 32 hex chars is 128 bits. */
export const MIN_TOKEN_LENGTH = 32;

export class TokenGate {
    constructor() {
        this._token = null;
        this._owner = null;
    }

    /**
     * Bind `token` to `owner` (the caller's D-Bus unique name). Succeeds only while nothing is
     * bound, for a real token of a real length and a named owner: first caller wins.
     */
    register(token, owner) {
        if (this._token !== null) return false;
        if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) return false;
        if (typeof owner !== 'string' || owner === '') return false;
        this._token = token;
        this._owner = owner;
        return true;
    }

    /**
     * Does this call carry the bound token? False when nothing is bound, or the token is missing,
     * not a string, empty or wrong.
     *
     * Constant time in the token's own bytes: the comparison never stops early, and a wrong LENGTH
     * is not a shortcut either - both strings are folded over the longer of the two, so neither the
     * content nor the length of the bound token is revealed by how long this takes.
     */
    check(token) {
        if (this._token === null) return false;
        if (typeof token !== 'string' || token.length === 0) return false;
        const bound = this._token;
        let difference = bound.length ^ token.length;
        const length = Math.max(bound.length, token.length);
        for (let i = 0; i < length; i++) {
            const a = i < bound.length ? bound.charCodeAt(i) : 0;
            const b = i < token.length ? token.charCodeAt(i) : 0;
            difference |= a ^ b;
        }
        return difference === 0;
    }

    /** Is `owner` (a D-Bus unique name) the one that holds the binding right now? */
    heldBy(owner) {
        return this._token !== null && owner === this._owner;
    }

    /** Forget the binding, but only for the owner that made it. */
    release(owner) {
        if (this._token === null || owner !== this._owner) return;
        this._token = null;
        this._owner = null;
    }
}
