# Shelter: Node runtime plus the Docker CLI, so the Depot can manage containers
# through the host's Docker socket (mounted by compose.yaml).
FROM node:22-alpine

# openssl makes the self-signed certificate when HTTPS is on (SHELTER_HTTPS=1).
RUN apk add --no-cache docker-cli openssl

WORKDIR /app
COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4077 \
    SHELTER_DATA=/data

EXPOSE 4077
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/status" || exit 1

CMD ["node", "server.js"]
