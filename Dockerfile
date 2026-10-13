FROM node:22-bookworm-slim

# Install system dependencies
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ffmpeg \
       python3 \
       python3-venv \
       curl \
       ca-certificates \
       unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Deno
ENV DENO_INSTALL=/opt/deno

RUN curl -fsSL https://deno.land/install.sh -o /tmp/install-deno.sh \
    && sh /tmp/install-deno.sh \
    && rm /tmp/install-deno.sh

ENV PATH="/opt/deno/bin:${PATH}"

# Create an isolated Python environment
RUN python3 -m venv /opt/yt-dlp-venv \
    && /opt/yt-dlp-venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/yt-dlp-venv/bin/pip install --no-cache-dir --upgrade "yt-dlp[default]" \
    && ln -s /opt/yt-dlp-venv/bin/yt-dlp /usr/local/bin/yt-dlp

# Set application directory
WORKDIR /app

# Install Node.js dependencies
COPY package*.json ./

RUN npm install --omit=dev

# Copy backend source code
COPY server.js ./

ENV NODE_ENV=production

CMD ["npm", "start"]
