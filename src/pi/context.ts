import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CommandRunner, HostContext, ModelGateway } from "../host/types.js";
import { createPiModelGateway } from "./models.js";

export function toHostContext(pi: CommandRunner, ctx: ExtensionContext): HostContext {
  let models: ModelGateway | undefined;
  return {
    get cwd() { return ctx.cwd; },
    get hasUI() { return ctx.hasUI; },
    get mode() { return ctx.mode; },
    get ui() { return ctx.ui; },
    get models() { return models ??= createPiModelGateway(pi, ctx); },
    isIdle: () => ctx.isIdle(),
  };
}
