#!/bin/sh
set -eu

: "${TURN_SERVER_PUBLIC_HOST:?TURN_SERVER_PUBLIC_HOST is required}"
: "${TURN_USERNAME:?TURN_USERNAME is required}"
: "${TURN_PASSWORD:?TURN_PASSWORD is required}"

envsubst < /etc/coturn/turnserver.conf.template > /tmp/turnserver.conf
exec turnserver -c /tmp/turnserver.conf
