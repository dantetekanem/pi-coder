Arrange this prepared symbol map for a human to read. Use filenames, symbol names and reference IDs; matching filenames and symbols have already supplied likely code/test pairs. References are local identifier matches, not a resolved call graph.

Return only compact JSON: {"order":["u3","u1"],"pairs":[["u1","u4"]]}.

`order` moves those unit IDs to the front, in that order. Omitted units follow in their existing file/source order. Paired tests appear beside their code, once. `pairs` contains only corrections or additions to the supplied pairs, as [code ID, test ID]; it moves each test to that code unit. Keep the supplied pairs when they fit. The host puts each remaining test beside the code that owns the nearest paired test in its file, and shows a test file without pairs as one step.

Put a likely entry point before the units it references. Keep the prepared order when there is no clear improvement. Return {"order":[],"pairs":[]} when the prepared order and pairs already fit. The host handles complete coverage, titles and line ranges. Make this arrangement decision in one pass and return the IDs.
