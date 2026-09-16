import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Production ships TypeScript with .js imports; resolve those imports for a real Node child.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
      const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (source.protocol === "file:" && fs.existsSync(fileURLToPath(source))) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const sessions = await import("../../review-session.ts");
let loaded;
let identity;
process.on("message", (command) => {
  try {
    if (command.action === "load") {
      identity = command.identity;
      loaded = sessions.loadReviewSession(identity) ?? command.data;
      process.send({ kind: "loaded", generation: loaded.generation ?? null });
      return;
    }
    if (command.action === "delete") {
      process.send(sessions.deleteReviewSession(identity, undefined, loaded.generation));
      return;
    }
    if (command.note != null) loaded.state.draft.allComment = command.note;
    if (command.comment != null) loaded.state.draft.comments[0].body = command.comment;
    if (command.action === "consume") loaded.state.draft = { allComment: "", allIntent: "comment", comments: [] };
    const rename = fs.renameSync;
    if (command.pause) {
      const pauseTarget = command.pauseAt === "index"
        ? join(process.env.PI_CODE_DIFF_SESSIONS_DIR, "index.json")
        : sessions.getReviewSessionPathForDiagnostics(sessions.createReviewSessionId(identity));
      fs.renameSync = (from, to) => {
        if (to === pauseTarget) {
          process.send({ kind: command.pauseAt === "index" ? "at-index-replace" : "at-replace" });
          // FIFO open/read blocks in the kernel until the parent releases this exact replacement.
          const barrier = fs.openSync(command.pause, "r");
          try {
            if (fs.readSync(barrier, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error("Barrier closed before release");
          } finally {
            fs.closeSync(barrier);
          }
        }
        return rename(from, to);
      };
      syncBuiltinESMExports();
    }
    try {
      process.send(sessions.saveReviewSessionWithStatus(identity, loaded, {
        revision: "head", expectedGeneration: loaded.generation ?? null,
      }));
    } finally {
      fs.renameSync = rename;
      syncBuiltinESMExports();
    }
  } catch (error) {
    process.send({ kind: "error", message: String(error) });
  }
});
process.send({ kind: "ready" });
