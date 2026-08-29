FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js .
ENV PORT=8000 MAX_PLAYERS=6
EXPOSE 8000
CMD ["node", "server.js"]
