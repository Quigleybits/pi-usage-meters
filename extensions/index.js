import { Text } from "@earendil-works/pi-tui";
import { createUsageLoader, renderContent } from "./core.js";

export default function (pi) {
  const loadUsage = createUsageLoader();

  pi.registerEntryRenderer("provider-usage", (entry) => (
    new Text(renderContent(entry.data), 0, 0)
  ));

  pi.registerCommand("usage", {
    description: "Show subscription quota for logged-in OAuth providers",
    handler: async (args, ctx) => {
      const arg = String(args ?? "").trim();
      if (arg && arg !== "--refresh") {
        ctx.ui.notify("Usage: /usage [--refresh]", "warning");
        return;
      }
      pi.appendEntry("provider-usage", await loadUsage(ctx, arg === "--refresh"));
    },
  });
}
