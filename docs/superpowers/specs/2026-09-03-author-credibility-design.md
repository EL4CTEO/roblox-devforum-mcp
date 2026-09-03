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

**Rule — show a badge only when it carries information.**

| Condition | Shown |
| --- | --- |
| `username` is `system` | nothing — Discourse's own bot |
| `staff`, `admin` or `moderator` | `(Roblox staff)` |
| `flair_name` | `(Programmers)` |
| otherwise | nothing |

### Trust level was designed in, then removed

The first draft badged `trust_level` 3 and 4 as earned standing. Checking it against live
threads killed it: **Roblox does not use Discourse's promotion ladder.** loleris — author of
ProfileService, 1567 likes on the post, the most-used data module on the platform — is
**TL1**, identical to an account opened yesterday. So is every other community author
sampled. The only accounts above TL1 are staff and the `system` bot.

A trust badge would therefore repeat the staff flag where it fires and say nothing anywhere
else, while implying the absence of a badge means an inexperienced author. Dropped.

### The bot was being introduced as Roblox staff

Discourse sets `staff: true` on its own `system` account, so post #2 of the Weekly Recap
thread rendered as `system (Roblox staff)` above "This topic was automatically opened after
10 minutes" — a bot notice presented as an employee's reply. Two causes, both fixed:
`authorBadge` never badges `system`, and `isAutomated` only matched "automatically closed"
and "automatically deleted", so "opened" slipped through.

## Result

```
--- #1 by frecklesnspectacles (Roblox staff) · 6 days ago · 22 likes
--- #4 by ParadoxSoftwork (Programmers) · 6 days ago · 10 likes
--- #3 by Bestspyboy · 6 days ago · 4 likes
```

## Components

- `authorBadge(post): string` in `src/tools/forum.ts` — pure, unit-testable, no network.
- `renderPost` calls it in place of the existing inline staff check.
- Two fields added to the `RawPost` interface in `src/discourse.ts`, both optional.

## Error handling

Every field is optional and absent on some posts. A missing field means no badge, never a
crash and never a guess. `system` bot posts are already dropped by `isAutomated`, so the
staff flag Discourse sets on them never reaches a reader.

## Testing

`authorBadge` is pure, so the table above becomes assertions directly: staff wins over
flair, `system` is never badged whatever its flags say, a trust level of 4 alone produces
nothing, and an empty post object returns an empty string. `isAutomated` gets the four bot
phrasings plus a real post that merely quotes one.
