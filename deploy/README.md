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

sudo chown -R <admin-user>:pi-conductor-runner \
  /opt/pi-conductor-vikunja-runner
sudo chmod -R g+rX /opt/pi-conductor-vikunja-runner

cd /opt/pi-conductor-vikunja-runner
pnpm install --frozen-lockfile
pnpm build
sudo install -o root -g pi-conductor-runner -m 0640 config.example.yaml \
  /etc/pi-conductor-vikunja-runner/config.yaml
```

Replace `<admin-user>` with the account that owns and updates the checkout. Build
as that account, without `sudo`; the service account needs read/execute access to
the built tree but does not need to modify it.

Edit the installed YAML to set the managed project values and set the one global
manifest path. It is a runner-level value, not a project-level value:

```yaml
runner:
  conductor_manifest: "/absolute/path/to/.pi/conductor.yaml"
```

Every project uses that file. The runner does not copy it into `/etc`, its data
directory, or a repository. Relative role and subagent `system_prompt` paths in
this shared layout require a version 2 pi-conductor manifest and resolve from the
manifest's directory. A version 1 manifest can be shared only when all prompt
paths are absolute.

The unit exposes home directories read-only. If the configured manifest is under
an operator home, grant the service account traverse access to its parent
directories and read access only to the manifest and referenced prompt files.
For example, for a manifest under `/home/<operator>/.pi` with prompts under its
`roles` directory:

```sh
sudo setfacl -m u:pi-conductor-runner:--x /home/<operator>
sudo setfacl -m u:pi-conductor-runner:--x /home/<operator>/.pi
sudo setfacl -m u:pi-conductor-runner:r-- \
  /home/<operator>/.pi/conductor.yaml
sudo setfacl -R -m u:pi-conductor-runner:rX \
  /home/<operator>/.pi/roles
sudo -u pi-conductor-runner test -r \
  /home/<operator>/.pi/conductor.yaml
```

Repeat the last ACL rule for any other prompt subtree referenced by the manifest.
Do not grant the service account read access to provider credentials or unrelated
files in the operator's home. If `setfacl` is unavailable, install the host's
`acl` package or use an equivalently narrow group-permission setup.

For a protected-file
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

The service unit grants write access only to the configured runner data directory
and exposes operator home files read-only, still subject to normal Unix
permissions and ACLs. It prevents privilege escalation, private-device access,
and writes to the code or configuration trees. Git credentials must be available
to the service user through the host's normal SSH credential setup; do not place
private keys in this repository or in task content.

Install the unit:

```sh
sudo install -o root -g root -m 0644 \
  deploy/pi-conductor-vikunja-runner.service \
  /etc/systemd/system/pi-conductor-vikunja-runner.service
sudo systemctl daemon-reload
```

Run validation as the service account before enabling the daemon so filesystem,
manifest, model, Git, analytics, and Vikunja errors are reported together:

```sh
sudo -u pi-conductor-runner /usr/bin/node \
  /opt/pi-conductor-vikunja-runner/dist/src/cli/main.js validate \
  --config /etc/pi-conductor-vikunja-runner/config.yaml
```

Then start the single service replica:

```sh
sudo systemctl enable --now pi-conductor-vikunja-runner.service
```

When migrating an existing configuration, add the single
`runner.conductor_manifest` value and remove every project-level
`conductor_manifest`. Validation rejects the old project-level field instead of
silently ignoring it.

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
