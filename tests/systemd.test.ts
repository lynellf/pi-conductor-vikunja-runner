import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const unitPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../deploy/pi-conductor-vikunja-runner.service",
);

describe("systemd service packaging", () => {
  it("runs the daemon as an unprivileged, single supervised service", async () => {
    const unit = await readFile(unitPath, "utf8");

    expect(unit).toContain("User=pi-conductor-runner");
    expect(unit).toContain("Group=pi-conductor-runner");
    expect(unit).toContain(
      "ExecStart=/usr/bin/node /opt/pi-conductor-vikunja-runner/dist/src/cli/main.js run --config /etc/pi-conductor-vikunja-runner/config.yaml",
    );
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("KillSignal=SIGTERM");
    expect(unit).toContain("NoNewPrivileges=true");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ProtectHome=read-only");
    expect(unit).toContain(
      "ReadWritePaths=/var/lib/pi-conductor-vikunja-runner",
    );
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
  });
});
