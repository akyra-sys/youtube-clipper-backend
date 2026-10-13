FROM node:22-bookworm-slim

ENV DENO_INSTALL=/usr/local

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       python3 \
       python3-venv \
       curl \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deno.land/install.sh | sh

RUN python3 -m venv /opt/yt-dlp-venv \
    && /opt/yt-dlp-venv/bin/pip install --no-cache-dir --upgrade "yt-dlp[default]" \
    && ln -s /opt/yt-dlp-venv/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production

CMD ["npm", "start"]
