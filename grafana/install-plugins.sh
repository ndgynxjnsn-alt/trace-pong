#!/bin/sh
# Unpack every plugin ZIP mounted at /plugin-zips into Grafana's plugin folder, then start Grafana.
# (Grafana itself only installs ZIPs from http(s) URLs, not from local files.)
set -e
for z in /plugin-zips/*.zip; do
  [ -e "$z" ] || continue
  for d in $(unzip -Z1 "$z" | cut -d/ -f1 | sort -u); do rm -rf "/var/lib/grafana/plugins/$d"; done
  unzip -oq "$z" -d /var/lib/grafana/plugins
  echo "installed plugin from $z"
done
exec /run.sh "$@"
