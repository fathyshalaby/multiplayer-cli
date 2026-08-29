# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/fathyshalaby/multiplayer-cli/security/advisories/new).
It is private between you and the maintainer, and it works even if you have
never contributed here before.

If that is unavailable to you, open a normal issue saying only that you have
found something security-relevant and would like a private channel — **no
details** — and you will be contacted.

Please include, when you can:

- what an attacker can do, in one sentence
- the steps to reproduce it
- the version or commit you were on

There is no bounty. This is a weekend project under the MIT licence, maintained
by one person. You will get a considered reply and credit in the release notes
unless you would rather not be named.

## What is in scope

Anything that breaks a claim in [the security model](./docs/security.md). The
ones worth stating plainly:

- Reading or altering room traffic without the room's token.
- Getting a seat, or a vote, without the token.
- Escaping the room's working directory, or the machine's own boundaries,
  through a tool the room approved.
- Making a relay serve, store, or hand over something it should not.
- Anything that lets a prompt or a tool call reach the model without the
  decision the room's policy requires.

## What is not

These are known and documented, not vulnerabilities:

- **Anyone holding the share link can join and read everything.** The link is
  the trust boundary, by design. See
  [the security model](./docs/security.md#the-link-is-a-bearer-secret).
- **The host sees and runs everything.** They own the session and the machine
  it runs on.
- **`--open` rooms are unencrypted.** That is what the flag means, and both
  ends say so before you use it.
- **A pooled runner approves its own tool calls.** Documented in
  [account pooling](./docs/pooling.md); the room and the runner both announce it.
- **The transcript is plain text on the host's disk.** It is an audit log on
  purpose. It is written `0600`.

## Where the boundaries are written down

[`docs/security.md`](./docs/security.md) is the honest version: what is
protected, what is not, and what has never been audited. Nothing here has been
reviewed by a third party.
