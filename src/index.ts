/**
 * pi-nextcloud — Pi extension for Nextcloud.
 *
 * Provides LLM tools for:
 *   - Notes     (Nextcloud Notes REST API)
 *   - Calendar  (CalDAV, VEVENT)
 *   - Tasks     (CalDAV, VTODO)
 *   - Contacts  (CardDAV, vCard)
 *
 * Configuration: /nextcloud-setup command, ~/.pi/agent/nextcloud.json
 * or NEXTCLOUD_URL / NEXTCLOUD_USERNAME / NEXTCLOUD_APP_PASSWORD env vars.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { defaultConfigPath, loadConfig, saveConfig } from "./config.ts";
import { NextcloudClient } from "./client.ts";
import { registerAllTools } from "./tools.ts";

export default function nextcloudExtension(pi: ExtensionAPI): void {
  registerAllTools(pi);

  pi.registerCommand("nextcloud-setup", {
    description: "Configure the Nextcloud server connection (URL, username, app password)",
    handler: async (_args, ctx) => {
      const current = loadConfigSafe();
      if (!ctx.hasUI) {
        ctx.ui.notify(
          `Non-interactive mode: create ${defaultConfigPath()} with {"baseUrl", "username", "password"} ` +
            `or set NEXTCLOUD_URL / NEXTCLOUD_USERNAME / NEXTCLOUD_APP_PASSWORD.`,
          "info",
        );
        return;
      }

      const baseUrl = await ctx.ui.input(
        "Nextcloud URL:",
        current?.config.baseUrl ?? "https://cloud.example.com",
      );
      if (baseUrl === undefined) return;
      if (baseUrl.trim() === "") {
        ctx.ui.notify("Setup cancelled: empty URL", "warning");
        return;
      }

      const username = await ctx.ui.input("Username:", current?.config.username);
      if (username === undefined) return;
      if (username.trim() === "") {
        ctx.ui.notify("Setup cancelled: empty username", "warning");
        return;
      }

      const password = await ctx.ui.input(
        "App password (Settings → Security → Devices & sessions):",
        "",
      );
      if (password === undefined) return;
      if (password.trim() === "") {
        ctx.ui.notify("Setup cancelled: empty password", "warning");
        return;
      }

      try {
        const path = saveConfig({ baseUrl, username, password });
        const client = new NextcloudClient({ baseUrl, username, password });
        await client.ensureDiscovered();
        await client.listCalendars();
        ctx.ui.notify(`Nextcloud connection OK, config saved to ${path}`, "info");
      } catch (err) {
        ctx.ui.notify(`Setup failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("nextcloud-check", {
    description: "Test the Nextcloud connection and show available collections",
    handler: async (_args, ctx) => {
      const loaded = loadConfigSafe();
      if (!loaded) {
        ctx.ui.notify("Not configured. Run /nextcloud-setup first.", "warning");
        return;
      }
      try {
        const client = new NextcloudClient(loaded.config);
        await client.ensureDiscovered();
        const calendars = await client.listCalendars();
        const addressbooks = await client.listAddressbooks();
        const lines = [
          `Server: ${loaded.config.baseUrl}`,
          `User: ${loaded.config.username}`,
          `Calendars: ${calendars.length ? calendars.map((c) => c.name).join(", ") : "none"}`,
          `Address books: ${addressbooks.length ? addressbooks.map((a) => a.name).join(", ") : "none"}`,
        ];
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err) {
        ctx.ui.notify(`Connection check failed: ${(err as Error).message}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const loaded = loadConfigSafe();
    if (loaded) {
      ctx.ui.setStatus("nextcloud", loaded.config.baseUrl.replace(/^https?:\/\//, ""));
    }
  });
}

function loadConfigSafe(): ReturnType<typeof loadConfig> {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}