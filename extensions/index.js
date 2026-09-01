import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createUsageLoader, cursorLogin, cursorRefresh, renderContent } from "./core.js";

export default function (pi) {
  // readStoredCredential is pi's public one-off credential read; the Copilot meter is its only consumer.
  const loadUsage = createUsageLoader({ readCredential: readStoredCredential });

  // Grok Bot credits are metered on a Cursor account (SuperGrok links are usage grants there),
  // so the meter authenticates as Cursor: browser handoff at cursor.com, token poll + rotating
  // refresh against api2.cursor.sh. pi stores and refreshes the pair like every other provider.
  pi.registerProvider("cursor", {
    oauth: {
      name: "Cursor (Grok Bot)",
      login: async (callbacks) => cursorLogin({ onAuth: callbacks.onAuth }),
      refreshToken: (credentials, signal) => cursorRefresh(credentials, { signal }),
      getApiKey: (credentials) => credentials.access,
    },
  });

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
