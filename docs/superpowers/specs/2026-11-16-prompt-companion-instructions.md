# Goal-oriented companion role

The approved role is now implemented in [the canonical runtime instruction source](../../../plugins/prompt-suggestion/src/instructions.ts), exported as `DEFAULT_INSTRUCTIONS`; the same file defines the strict output contract. Owner base instructions are composed at runtime from the shared core source, preserving full BIBLE. This document intentionally does not duplicate the executable prompt.

The accepted design, goal/drift policy and validation boundaries remain in [the companion design](2026-11-16-prompt-companion-design.md). Local implementation does not imply release, production activation or a latency/quality pass.
