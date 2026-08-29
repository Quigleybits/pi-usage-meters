import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createUsageLoader, renderContent } from "./core.js";

export default function (pi) {
  // readStoredCredential is pi's public one-off credential read; the Copilot meter is its only consumer.
  const loadUsage = createUsageLoader({ readCredential: readStoredCredential });

  pi.registerEntryRenderer("provider-usage", (entry) => (
    new Text(renderContent(entry.data), 0, 0)
  ));

  pi.registerCommand("usage", {
    description: "Show subscription quota for connected providers",
    handler: async (args, ctx) => {
      const flags = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      if (flags.some((flag) => flag !== "--refresh" && flag !== "--all")) {
        ctx.ui.notify("Usage: /usage [--refresh] [--all]", "warning");
        return;
      }
      const data = await loadUsage(ctx, flags.includes("--refresh"));
      // --all keeps the per-provider login hints as blocks instead of the one-line footer summary.
      pi.appendEntry("provider-usage", flags.includes("--all") ? { ...data, all: true } : data);
    },
  });
}
