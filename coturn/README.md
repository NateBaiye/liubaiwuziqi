# Coturn Setup

This folder contains a simple Coturn configuration you can host on your own server.

## 1. Edit the config

Open [turnserver.conf](/Users/akashibaba/Desktop/Gomoku/coturn/turnserver.conf) and replace:
- `YOUR_SERVER_PUBLIC_IP_OR_DOMAIN`
- `YOUR_TURN_USERNAME`
- `YOUR_TURN_PASSWORD`

## 2. Start Coturn

Example:

```bash
turnserver -c /path/to/turnserver.conf
```

## 3. Open the firewall

Allow:
- `3478/tcp`
- `3478/udp`
- `5349/tcp` if you enable TLS
- relay range `49160-49200/tcp`
- relay range `49160-49200/udp`

## 4. Put the values into your app

In Render, set:

```text
TURN_URLS=turn:YOUR_SERVER_PUBLIC_IP_OR_DOMAIN:3478,turn:YOUR_SERVER_PUBLIC_IP_OR_DOMAIN:3478?transport=tcp
TURN_USERNAME=YOUR_TURN_USERNAME
TURN_CREDENTIAL=YOUR_TURN_PASSWORD
```

If you also configure TLS for Coturn, you can use:

```text
TURN_URLS=turn:YOUR_SERVER_PUBLIC_IP_OR_DOMAIN:3478,turn:YOUR_SERVER_PUBLIC_IP_OR_DOMAIN:3478?transport=tcp,turns:YOUR_SERVER_PUBLIC_IP_OR_DOMAIN:5349?transport=tcp
```

## Notes

- `external-ip` should be your server's public IP or a DNS name that points to it.
- If your Coturn server is behind NAT, use the actual public IP.
- For calls across stricter networks, `turns:...:5349?transport=tcp` is usually the most reliable option.
