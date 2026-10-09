<!--
  <meta:header>
    <meta:licence>
      Copyright (C) 2026 by Wizzard Solutions Ltd, wizzard@metagrid.co.uk

      This information is free software: you can redistribute it and/or modify
      it under the terms of the GNU General Public License as published by
      the Free Software Foundation, either version 3 of the License, or
      (at your option) any later version.

      This information is distributed in the hope that it will be useful,
      but WITHOUT ANY WARRANTY; without even the implied warranty of
      MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
      GNU General Public License for more details.

      You should have received a copy of the GNU General Public License
      along with this program.  If not, see <http://www.gnu.org/licenses/>.
    </meta:licence>
  </meta:header>

  AIMetrics: [
      {
      "timestamp": "2026-10-07T03:37:40",
      "name": "@deepseek-ai/dsh",
      "version": "0.2.0-rc.2",
      "model": "deepseek-flash",
      "contribution": {
        "value": 70,
        "units": "%"
        }
      },
      {
      "timestamp": "2026-10-09T10:05:00",
      "name": "@deepseek-ai/dsh",
      "version": "0.2.0-rc.2",
      "model": "deepseek-flash",
      "contribution": {
        "value": 55,
        "units": "%"
        }
      }
    ]
-->

# Lithosia
DeepSeek harness - notes and tools 

This project is named after the [Lithosia quadra](https://en.wikipedia.org/wiki/Lithosia_quadra) Four-Spotted Footman, 四点苔蛾.

<a title="Erkiheiki, CC BY-SA 4.0 &lt;https://creativecommons.org/licenses/by-sa/4.0&gt;, via Wikimedia Commons" href="https://commons.wikimedia.org/wiki/File:Lithosia_quadra_(female).jpg"><img width="250" alt="Lithosia quadra (female)" src="https://thumb.wikimedia.org/wikipedia/commons/thumb/1/16/Lithosia_quadra_%28female%29.jpg/250px-Lithosia_quadra_%28female%29.jpg?utm_source=commons.wikimedia.org&utm_campaign=index&utm_content=thumbnail"></a>

<a title="Four-point moth Lithonia quadra" href="http://liudayadan.com/node.php?name=%E5%9B%9B%E7%82%B9%E8%8B%94%E8%9B%BE%20Lithosia%20quadra"><img width="512" alt="Four-point moth Lithonia quadra" src="http://liudayadan.com/Pictures/%E5%9B%9B%E7%82%B9%E8%8B%94%E8%9B%BE%20Lithosia%20quadra.jpg"></a>

## Running the container

The harness runs in a container built from `docker/Dockerfile`. Two things are
mounted separately, so a container can have either one without the other:

 * **The project source**, pointed to by `LITHOSIA_CODE` and mounted at
   `/Zarquan/lithosia-quadra`. Needed to read or edit this project.
 * **The harness home**, pointed to by `DSH_HOME` and mounted at `/opt/dsh`.
   This is the harness's single root for user data: profiles, installed
   plugins, session logs, credentials and backups. The host copy lives in
   `dsh/`, which `.gitignore` excludes.

| Variable | Container path | Host source | Purpose |
|---|---|---|---|
| `LITHOSIA_CODE` | `/Zarquan/lithosia-quadra` | this clone | The project source. |
| `DSH_HOME` | `/opt/dsh` | `<clone>/dsh` | The harness home. |

### Launch variants

Both mounts, for an agent that can also edit this project:

```bash
podman run \
    --rm \
    --tty \
    --interactive \
    --pod    "lithosia-dsh-pod" \
    --name   "lithosia-dsh-container" \
    --env    "CONTAINER_HOST=unix:///run/podman/podman.sock" \
    --volume "${HOST_CONTAINER_PATH}:/run/podman/podman.sock:rw,Z" \
    --env    "LITHOSIA_CODE=/Zarquan/lithosia-quadra" \
    --volume "${LITHOSIA_CODE:?}:/Zarquan/lithosia-quadra:rw,Z" \
    --env    "DSH_HOME=/opt/dsh" \
    --volume "${LITHOSIA_CODE:?}/dsh:/opt/dsh:rw,Z" \
    localhost/zarquan/lithosia-quadra:latest \
        bash
```

Source only, to read or edit this project with no harness:

```bash
podman run \
    ....
    --env    "LITHOSIA_CODE=/Zarquan/lithosia-quadra" \
    --volume "${LITHOSIA_CODE:?}:/Zarquan/lithosia-quadra:rw,Z" \
    ....
```

Harness only, to run the agent against other mounted projects with no copy of
this project's source:

```bash
podman run \
    ....
    --env    "DSH_HOME=/opt/dsh" \
    --volume "${LITHOSIA_CODE:?}/dsh:/opt/dsh:rw,Z" \
    ....
```

### Notes

 * The harness home has to be mounted. Without it `DSH_HOME` resolves to a path
   inside the container's own filesystem, so every profile, plugin and session is
   lost when the container is removed.
 * Only one container should use a given harness home at a time. Two harnesses
   writing the same session state corrupt it. For parallel agents give each its
   own home, for example `--volume "${LITHOSIA_CODE:?}/dsh-<name>:/opt/dsh:rw,Z"`.
 * The `:rw,Z` suffix matters: `Z` relabels the mount for SELinux, and without
   write access the harness cannot persist anything.
 * On a fresh home the web proxy plugin has to be installed once. The image runs
   `init-dsh.sh` at build time, but `DSH_HOME` is unset during the build, so that
   installs into the harness's *default* home rather than the mounted one. Run it
   again inside the container:

   ```bash
   /usr/local/bin/init-dsh.sh
   ```

   It is idempotent — it reinstalls the plugin and reapplies the
   `dsh-client-connection` patch, both against the mounted home. Then start the
   harness with `dsh web --no-open`. The Web UI listens on 3080 inside the
   container, and the proxy plugin publishes 3081.

 * `VOLUME /root/.dsh` in the image is a leftover from when the harness used
   DSH's default home. It is unused whenever `DSH_HOME` is set, and it creates an
   empty anonymous volume on every run.
 * Nothing here is DSH-specific in principle: another harness would get its own
   variable and its own mount, and a project would choose which to mount.
