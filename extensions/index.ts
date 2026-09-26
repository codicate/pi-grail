import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Questions } from "@typesafe-ai/sdk";
import { evaluate, listModels, smoke, status } from "../src/jev.js";
import { registerGrail } from "./grail.js";

export default function (pi: ExtensionAPI) {
  registerGrail(pi);
  // Raw Jev commands do not infer at startup. Monitored workers live in registerGrail.
  function show(ctx: ExtensionContext, data: unknown, failed = false) {
    const text = JSON.stringify(data, null, 2);
    if (ctx.mode === "print") console.log(text);
    else pi.sendMessage({ customType: "pi-grail-jev", content: text, display: true, details: data });
    if (failed && ctx.hasUI) ctx.ui.notify("Jev request failed; see the result.", "error");
  }

  pi.registerCommand("jev", {
    description: "Jev API bootstrap: /jev status, /jev models, /jev test",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      try {
        if (command === "status") show(ctx, { ...status(), tools: ["jev_evaluate"], automaticReview: false });
        else if (command === "models") show(ctx, await listModels(ctx.signal));
        else if (command === "test") show(ctx, await smoke(ctx.signal));
        else show(ctx, { error: "Use /jev status, /jev models, or /jev test." }, true);
      } catch (error) {
        show(ctx, { error: error instanceof Error ? error.message : "Jev request failed." }, true);
      }
    },
  });

  pi.registerTool({
    name: "jev_evaluate",
    label: "Jev Evaluate",
    description: "Send explicitly supplied state and typed questions to TypeSafe Jev. Returns the raw API answers; no review or routing policy is applied.",
    parameters: Type.Object({
      state: Type.Any({ description: "Text, JSON object, or array to send to Jev." }),
      questions: Type.Record(Type.String(), Type.Object({
        type: StringEnum(["choice", "noul", "score"] as const),
        instructions: Type.Any({ description: "The question; text or structured JSON." }),
        criteria: Type.Optional(Type.Any({ description: "Choice labels, Score levels, or optional Noul true/false descriptions." })),
      })),
      model: Type.Optional(Type.String()),
    }),
    async execute(_id, params, signal) {
      const response = await evaluate({
        state: params.state, questions: params.questions as Questions, model: params.model,
      }, signal);
      return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: response };
    },
  });
}
