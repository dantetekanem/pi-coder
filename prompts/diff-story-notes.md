Also explain the story to the reviewer, who reads your notes in a sidebar beside the code. Each unit includes `changes`: its changed lines, with `-` for removed and `+` for added, cut short on long units.

Add two fields to the JSON: {"order":[],"pairs":[],"summary":"...","notes":{"u3":{"title":"...","text":"..."}}}.

`summary` says in one or two sentences what the whole change does.

`notes` has one entry for each step, keyed by the unit ID that leads it: every code unit, and the first test unit of each test file whose tests have no code pair. `title` names what the step does in at most six words, such as "Cache the parsed settings". `text` explains in one to three short sentences what the step changes and how it builds on an earlier step or prepares a later one. When the step has tests, say what they check.

Write plain sentences for a reviewer who reads the code beside them. Use no Markdown and no line numbers. Do not praise the code or judge whether it is correct.
