# ----------------------------
# DEVELOPMENT
# ----------------------------
FROM node:20-alpine AS development

# Create app directory
WORKDIR /usr/src/app

# Puppeteer needs some dependencies, even for Alpine
RUN apk add --no-cache \
    udev \
    ttf-freefont \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    bash \
    dumb-init

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

COPY --chown=node:node package*.json ./

RUN npm ci

COPY --chown=node:node .. .

USER node

# ----------------------------
# BUILD
# ----------------------------
FROM node:20-alpine AS build

WORKDIR /usr/src/app

COPY --chown=node:node package*.json ./
COPY --chown=node:node --from=development /usr/src/app/node_modules ./node_modules
COPY --chown=node:node .. .

RUN npm run build

ENV NODE_ENV=production
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# ----------------------------
# PRODUCTION
# ----------------------------
FROM node:20-slim AS production

# Install Chromium dependencies for Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libappindicator1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgdk-pixbuf2.0-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    wget \
    chromium \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Puppeteer config
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY --chown=node:node --from=build /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=build /usr/src/app/dist ./dist


USER node

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]



