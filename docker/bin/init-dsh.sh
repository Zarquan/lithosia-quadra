#!/bin/sh
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
# AIMetrics: []
#
# Steps needed to (re)install and configure the web proxy module.
#

    set -eu

# -----------------------------------------------------
# (re)install the web proxy module.

    echo "---- ----"
    echo "Installing the web proxy module"

    dsh plugin --profile web add github:smanx/dsh-proxy#master

# -----------------------------------------------------
# (re)pply the fix to dsh-client-connection suggested by DeepSeek.
# https://chat.deepseek.com/share/hv7ag1f1spkn82jbps

    echo "---- ----"
    echo "Applying the fix to dsh-client-connection"

    sed -i '
        /^const inject =/ {
            s/^const inject = \["credentials"\];/const inject = \["webServer", "credentials"\];/
            }
        ' /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js

    sed -n '
        /^const inject =/ p
        ' /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js

    echo "---- ----"

