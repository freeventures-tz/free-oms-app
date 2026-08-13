# Translation dictionaries

Two languages in V1: **English** and **simple, everyday Tanzanian Swahili** (`design.md` §8.1).

`en.json` and `sw.json` must contain **exactly the same key set**. `tests/unit/messages.test.ts`
fails the build if they diverge, because a missing Swahili key becomes an English string in front of
a Swahili-speaking user.

> **The Swahili wording here is proposed, not approved.** `design.md` §8.4 and §8.6 require review by
> Tanzanian users who will actually operate the system, in context, before release. Terms staff
> already use in the yard beat textbook equivalents. Nothing in `sw.json` ships without that review.

Rules that are not negotiable (`design.md` §8.2):

- Every display string is a key. No hardcoded text anywhere — validation messages, empty states,
  error text, status labels and headings included.
- Never assemble a sentence from fragments. Word order differs between the two languages; use whole
  phrases with named placeholders (`{name}`, `{phone}`).
- Plurals go through the translation layer, not string logic.
