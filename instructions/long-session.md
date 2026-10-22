# Long-session rules

These rules apply to long tasks: hours of work, many tool calls, large projects. They are short on
purpose, because this file is sent with every request.

1. **State file.** Keep `.omo/state.md` current: the user's goal, decisions already made, files
   changed, what is done, and the next unfinished step. Update it after each meaningful milestone,
   not at the end. Facts only, no narration.
2. **Compaction.** The history can be compacted at any time. After a compaction, continue from the
   summary and `.omo/state.md`. Do not restart the task, do not ask the user again for anything
   already answered, and do not invent new work.
3. **Reading.** Do not re-read a whole large file you have already read. Use grep, or read ranges
   with offset and limit. If a tool output says text was removed by `[omni-resilience]`, that text
   is gone from your context: run the tool again with a narrower query and never guess the missing
   part.
4. **Automatic notes.** A message that starts with `[omni-resilience]` is an automatic note from the
   client, not from the user. Follow it, then keep working on the user's task.
5. **Verification.** Before you say a step is done, run the check that proves it (tests, build, type
   check, a quick run). Report what you verified and what you could not verify.
6. **Scope.** Do exactly the task that was asked. List unrelated problems you notice in
   `.omo/state.md` under "Found, not fixed" instead of fixing them silently.
