---
title: "model-judge-human-mismatch"
description: "Gotcha distilled by vir from a Claude Code session on 2026-09-12. This session ran a blind A/B of vir's distill prompt against real transcripts, shipped the winner as v0.18.0, and then r"
editUrl: false
---

:::note[Written by vir, not by a human]
**Gotcha** · session `b147175c` · 2026-09-12 · classifier confidence 0.92
:::

## Summary

This session ran a blind A/B of vir's distill prompt against real transcripts, shipped the winner as v0.18.0, and then reviewed the shipped prompt. The main finding is that notes have two readers with opposite preferences. On the same forced-choice test over 80-word note tops, the human chose the old prompt 14 to 1 and Fable 5.1 chose the first challenger 14 to 0, so a model-judged rubric cannot stand in for a human check. The shipped prompt is `buildDistillPrompt` in `src/pipeline/distiller.ts`, pinned byte-for-byte to `eval/distill/COMBINED.md` by `eval/distill/prompts.test.ts`, with the output cap raised from 1500 to 2500. The daemon's `claude` login expired, so the prompt has produced no real notes yet.

## What Was Learned

- **A model-judged rubric disagreed with the human on direction.** The rubric judges (Fable, Sonnet) called the first challenger a tie (Fable +0.12, p=0.095). The human forced choice on note tops went 14 to 1 for the control (p=0.001), and human and Fable agreed on 1 of 9 pairs. Fable's stated criterion was "current state and facts git can't give back". The human's was "what the session was". Do not tune this prompt against a model judge without a human forced-choice check (`npm run distill:quick`).
- **The shipped prompt is "orient, then claim".** Summary sentence 1 says what the session was, and sentence 2 states the most important established fact with its specifics. It passed a success rule fixed before any output existed. The human was indifferent, 8 to 7. Fable preferred it 10 to 1 on full notes (p=0.012). It was chosen over a word bound: the first challenger's hard "under 400 words" was still exceeded by 6 of 15 notes, so bounds are followed loosely. The distill cap went 1500 to 2500 instead. The Haiku echo guard, "You are writing a page about the session, not replying to it", is in the prompt because the longer challenger made Haiku output a Serbian end-of-session chat message instead of a note.
- **A review of the shipped prompt found flaws that are unmeasured hypotheses:**
  - The classify title and the summary headline disagree in about 9 of 15 notes, because the distiller is never told the title.
  - Notes now name people ("the user (Djole)", "solo founder"). `/vault` publishes notes for project vir.
  - Summaries averaged 112 words against 68 for the control. 12 of 15 open with "the single most important finding".
  - Notes averaged 537 words against 416, and length may favour them with a model judge.
  - Instructions come first and then up to 200k tokens of transcript, so the last text the model reads is the session's final message. That is the likely cause of the Haiku echo. A transcript-first layout is the untested fix.
- **`claude -p` cannot run under a foreign `HOME` on macOS.** The login is in the Keychain, `CLAUDE_CONFIG_DIR` does not carry it, and the attempt triggered a Keychain prompt. Isolate experiments with explicit `--home` paths and run children under the real HOME.
- **The claude-cli transport has three quirks:**
  - It applies no `max_tokens`.
  - Its envelope `output_tokens` includes thinking tokens, so a `>= 1500` cap-hit check is wrong there. Inspect the note tail instead.
  - launchd's PATH lacks `~/.local/bin`, so `claude` had to be symlinked into `/opt/homebrew/bin`.
- **Two failures hid for a long time.**
  - API credits were empty from August, so distills quietly failed. Later, an expired claude-cli OAuth login made every daemon run fail from 2026-09-23. A failed preflight (`run.ts` around line 793) records no per-session rows, so neither `failureNotice` nor doctor shows it.
  - A tag is not an install. The global `vir` was 0.17.0 while 0.17.2–0.17.8 were tagged, because `npm publish` was blocked on login. After a release, check `vir --version` and the launchd `ProgramArguments` path.
- **The experiment could only reach 13 of 411 distilled transcripts.** Claude Code prunes transcripts at about 30 days, and pre-0.14.0 rows have a null entrypoint. Two worktree top-ups brought the sample to 15. Worktree directories (`<proj>--claude-worktrees-<x>`) do not inherit their parent project's decision, so they sit as `project-pending` and can expire.
- **Paid workers must flush per item.** The first A/B worker wrote its output once, at the end. A 400 on the 15th control call lost 14 paid results, recovered only from the arm DB and `cost.log`. The fix was per-transcript flush plus `run --resume <dir>`.
- **Two rubric dimensions were dead.** Specific and Correctable sat at 1.73–2.00 for both arms under both judges. Narration suppressed and Decision recorded are where the weakness was.
- **Smaller gotchas:**
  - `npm test` fires real desktop notifications and writes the real `daemon.log` (`run.claudeCli.test.ts`, since 0.17.8).
  - `build-vault.mjs` wiped the hand-written `/vault` index on every rebuild, and its typed note count drifted (43 vs 40).
  - The scrubber redacts `sk-ant-` but has no pattern for a bare 32-hex Kie key.

## Context

The session started as a roadmap item, "note quality unmeasured" (v7 Track C). It grew into a three-arm experiment, the prompt swap, a release, site updates and a provider switch to claude-cli. It ended with a post-ship review that found the daemon had not run the new prompt at all.

## Related

- [schema-enumeration-stops-drops](/vault/patterns/schema-enumeration-stops-drops-a2bc5634/)
- [cost-logging-architecture](/vault/decisions/cost-logging-architecture-e16e7aec/)
- dummy-model-masked-failures
- prerequisite-validation-blocks-launch
- [json-output-contract](/vault/decisions/json-output-contract-7bcca3cb/)
