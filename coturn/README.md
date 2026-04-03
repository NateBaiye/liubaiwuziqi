# Coturn Setup

This folder contains a Docker-based Coturn setup you can host on your own server.

## Files

- [docker-compose.yml](/Users/akashibaba/Desktop/Gomoku/coturn/docker-compose.yml)
- [turnserver.conf.template](/Users/akashibaba/Desktop/Gomoku/coturn/turnserver.conf.template)
- [entrypoint.sh](/Users/akashibaba/Desktop/Gomoku/coturn/entrypoint.sh)
- [\.env.example](/Users/akashibaba/Desktop/Gomoku/coturn/.env.example)

## 1. Create your env file

```bash
cd coturn
cp .env.example .env
```

Edit `.env` and set:
- `TURN_SERVER_PUBLIC_HOST`
- `TURN_USERNAME`
- `TURN_PASSWORD`

## 2. Start Coturn with Docker

```bash
cd coturn
docker compose up -d
```

The entrypoint will generate the final Coturn config from your `.env` values.

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
TURN_URLS=turn:YOUR_SERVER_PUBLIC_HOST:3478,turn:YOUR_SERVER_PUBLIC_HOST:3478?transport=tcp
TURN_USERNAME=YOUR_TURN_USERNAME
TURN_CREDENTIAL=YOUR_TURN_PASSWORD
```

If you also configure TLS for Coturn, you can use:

```text
TURN_URLS=turn:YOUR_SERVER_PUBLIC_HOST:3478,turn:YOUR_SERVER_PUBLIC_HOST:3478?transport=tcp,turns:YOUR_SERVER_PUBLIC_HOST:5349?transport=tcp
```

## Notes

- `TURN_SERVER_PUBLIC_HOST` should be your server's public IP or a DNS name that points to it.
- If your Coturn server is behind NAT, use the actual public IP.
- For calls across stricter networks, `turns:...:5349?transport=tcp` is usually the most reliable option.
