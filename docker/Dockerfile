#
# <meta:header>
#   <meta:licence>
#     Copyright (C) 2026 by Wizzard Solutions Ltd, wizzard@metagrid.co.uk
#
#     This information is free software: you can redistribute it and/or modify
#     it under the terms of the GNU General Public License as published by
#     the Free Software Foundation, either version 3 of the License, or
#     (at your option) any later version.
#
#     This information is distributed in the hope that it will be useful,
#     but WITHOUT ANY WARRANTY; without even the implied warranty of
#     MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#     GNU General Public License for more details.
#
#     You should have received a copy of the GNU General Public License
#     along with this program.  If not, see <http://www.gnu.org/licenses/>.
#   </meta:licence>
# </meta:header>
#
# AIMetrics: [
#     {
#     "timestamp": "2026-10-07T08:08:35",
#     "name": "@deepseek-ai/dsh",
#     "version": "0.2.0-rc.2",
#     "model": "deepseek-flash",
#     "contribution": {
#       "value": 5,
#       "units": "%"
#       }
#     }
#   ]
#
# Extension of the developer tools to add the DeepSeek agent harness.
# https://deepseek-code.com/
# https://deepseek.com/harness/en/
# https://github.com/deepseek-ai/deepseek-harness
#

ARG buildtag

FROM ghcr.io/ivoa/calycopis/developer-tools:2026.09.17

# https://docs.docker.com/v17.09/engine/reference/builder/#understand-how-arg-and-from-interact
ARG buildtag
ARG buildtime

LABEL maintainer "Zarquan <docker-admin@metagrid.co.uk>"
LABEL buildtag   "${buildtag}"
LABEL buildtime  "${buildtime}"
LABEL vendor     "Zarquan [https://github.com/Zarquan]"
LABEL version    "${buildtag}"
LABEL license    "GPL-3.0-or-later"
LABEL org.opencontainers.image.created  "${buildtime}"
LABEL org.opencontainers.image.vendor   "Zarquan [https://github.com/Zarquan]"
LABEL org.opencontainers.image.version  "${buildtag}"
LABEL org.opencontainers.image.licenses "GPL-3.0-or-later"
LABEL org.opencontainers.image.source   "https://github.com/Zarquan/lithosia-quadra"
LABEL org.opencontainers.image.authors  "https://github.com/Zarquan"

#
# Expose the DSH proxy port.
EXPOSE 3081/tcp

#
# Install the NodeJS toolkit
# https://nodejs.org/
RUN dnf install -y \
    nodejs

#
# Install pnpm package manager
# https://pnpm.io/
RUN dnf install -y \
    pnpm

#
# Install the GitHub CLI, which is in the Fedora repositories.
# No extra repository configuration is needed.
# https://cli.github.com/
RUN dnf install -y \
    gh

#
# Mount the user's dsh config directory as a volume which means it
# will not persist as part of the container image.
# The user should mount their own configuration at runtime.
VOLUME /root/.dsh

#
# Use the Node package manager to install DSH.
# https://github.com/deepseek-ai/deepseek-harness
# This step needs to be done again at runtime to update the installation
# because a lot of the configutation is saved in the user's configuration volume.
RUN npm install -g \
   '@deepseek-ai/dsh'

#
# Add our initialisation script.
COPY bin /usr/local/bin/
RUN chmod a+x /usr/local/bin/*.sh

#
# Run our initialisation script.
# This will need to be run again when the container starts.
# Part of the initialisation process writes to the DSH_HOME
# directory, which is mounted as a volume during the build
# and again at runtime.
RUN /usr/local/bin/init-dsh.sh

