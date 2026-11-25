# ISSS (IoT-Based Smart Surveillance System) Docker Container
FROM node:20-bookworm-slim

# Install system ffmpeg for camera acquisition and clip encoding
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first for Docker layer caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Ensure storage directories exist
RUN mkdir -p data media/stills media/clips evaluation

# Generate synthetic benchmark video so demo mode works out-of-the-box
RUN npm run make-test-video

ENV PORT=3000
ENV HOST=0.0.0.0
ENV APP_ENV=demo

EXPOSE 3000

CMD ["node", "src/backendServer.js"]
