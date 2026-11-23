# StableX — Node 22 on a slim Debian base.
FROM node:22-slim
WORKDIR /app

# Install dependencies first so source changes don't invalidate the layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
