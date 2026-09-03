# Author credibility on thread reads

**Status:** approved 2026-09-03

## Problem

`get_thread` hoists the accepted answer to the top, but "accepted" only means the person
who asked clicked a button. It carries no information about whether the answer came from
Roblox or from an account opened three days ago. A model reading a 2021 workaround has no
way to weigh it.

## Why not a user-profiling tool

The obvious shape — "look up this DevForum user" — is both off-mission and impossible:

- `GET /u/<name>.json` and `/u/<name>/summary.json` both return **HTTP 403** to an
  anonymous client. Solution counts and activity recency need a logged-in session, and this
  server is deliberately no-auth.
- A per-person dossier serves nobody debugging Luau. Credibility is only useful attached to
  an answer someone is about to act on.

## Design

Every signal needed is already in the topic payload `get_thread` and `get_replies` fetch.
Cost is zero extra requests.

```
staff = true    moderator/admin    trust_level = 0..4
flair_name = "Programmers"         user_title = "UI Designer"
```

**Scope:** `get_thread` and `get_replies` only. Search results carry none of these fields
(`search.json` posts have only `username`, `name`, `avatar_template`, `blurb`, `like_count`,
timestamps) and `users[]` comes back empty, so decorating eight search hits would mean eight
extra topic fetches on the tool's hottest path. Not worth it: search finds the thread,
credibility matters when reading it.

**Rule — show a badge only when it carries information.** Most DevForum accounts are TL1;
printing that on every post is noise.

| Condition | Shown |
| --- | --- |
| `staff`, `admin` or `moderator` | `(Roblox staff)` |
| `trust_level` 4 | `(TL4 leader)` |
| `trust_level` 3 | `(TL3 regular)` |
| `flair_name`, non-staff | `(Programmers)` |
| otherwise | nothing |

Flair and trust combine: `(Programmers · TL3 regular)`.

## Result

```
--- #1 by frecklesnspectacles (Roblox staff) · 6 days ago · 42 likes
--- #4 by loleris (Programmers · TL3 regular) · 2 yr ago · 65 likes
--- #7 by SomeNewAccount · 3 days ago
```

## Components

- `authorBadge(post): string` in `src/tools/forum.ts` — pure, unit-testable, no network.
- `renderPost` calls it in place of the existing inline staff check.
- Four fields added to the `RawPost` interface in `src/discourse.ts`, all optional.

## Error handling

Every field is optional and absent on some posts. A missing field means no badge, never a
crash and never a guess. `system` bot posts are already dropped by `isAutomated`, so the
staff flag Discourse sets on them never reaches a reader.

## Testing

`authorBadge` is pure, so the table above becomes assertions directly: staff wins over
trust level, TL1 and TL2 produce nothing, flair and trust combine, an empty post object
returns an empty string.
