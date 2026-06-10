FROM docker.io/library/node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY shared/ ./shared/
COPY server/ ./server/

ENV PORT=3000

CMD ["node", "server/index.js"]
