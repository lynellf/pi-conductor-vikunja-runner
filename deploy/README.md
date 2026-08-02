# systemd deployment

The runner is intended to run as one unprivileged native service. Build and install
it under a fixed path, then keep its configuration and credentials outside the
repository.

## Install

The following commands assume `/opt/pi-conductor-vikunja-runner` is the checked
out release and that `/usr/bin/node` is Node.js 22.19 or newer:

```sh
sudo useradd --system --home-dir /var/lib/pi-conductor-vikunja-runner \
  --create-home --shell /usr/sbin/nologin pi-conductor-runner
sudo install -d -o pi-conductor-runner -g pi-conductor-runner -m 0750 \
  /var/lib/pi-conductor-vikunja-runner
sudo install -d -o root -g pi-conductor-runner -m 0750 \
  /etc/pi-conductor-vikunja-runner/credentials

cd /opt/pi-conductor-vikunja-runner
sudo -u pi-conductor-runner pnpm install --frozen-lockfile
sudo -u pi-conductor-runner pnpm build
sudo install -o root -g pi-conductor-runner -m 0640 config.example.yaml \
  /etc/pi-conductor-vikunja-runner/config.yaml
```

Edit the installed YAML to set the managed project values. For a protected-file
credential setup, set `vikunja.token_file` to
`/etc/pi-conductor-vikunja-runner/credentials/vikunja_api_token` and
`runner.analytics_config_path` to
`/etc/pi-conductor-vikunja-runner/credentials/conductor-analytics.json`.
Install both files with owner-only permissions:

```sh
sudo install -o pi-conductor-runner -g pi-conductor-runner -m 0600 \
  ./vikunja_api_token \
  /etc/pi-conductor-vikunja-runner/credentials/vikunja_api_token
sudo install -o pi-conductor-runner -g pi-conductor-runner -m 0600 \
  ./conductor-analytics.json \
  /etc/pi-conductor-vikunja-runner/credentials/conductor-analytics.json
```

The service unit grants write access only to the configured runner data directory.
It prevents privilege escalation, private-device access, and writes to the code
or configuration trees. Git credentials must be available to the service user
through the host's normal SSH credential setup; do not place private keys in this
repository or in task content.

Install and start the unit:

```sh
sudo install -o root -g root -m 0644 \
  deploy/pi-conductor-vikunja-runner.service \
  /etc/systemd/system/pi-conductor-vikunja-runner.service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-conductor-vikunja-runner.service
```

## Operations

Check startup and runtime logs with:

```sh
sudo journalctl -u pi-conductor-vikunja-runner.service -f
pnpm runner:health -- --config /etc/pi-conductor-vikunja-runner/config.yaml
```

Stop the service with `systemctl stop`; SIGTERM lets the daemon finish its
current bounded lifecycle and flush analytics. Use `systemctl restart` after
configuration changes. The SQLite state, task worktrees, conductor sessions,
and analytics backfill files remain under the configured data directory and must
not be deleted during recovery.
