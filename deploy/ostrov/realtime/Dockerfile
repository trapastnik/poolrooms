FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js .
# серверный мир (общие монстры): геометрия и ИИ. Тесты (*.test.mjs) в образ
# не тащим — только рантайм-модули.
COPY world/level.js world/monsters.js ./world/
ENV PORT=8000 MAX_PLAYERS=6
EXPOSE 8000
CMD ["node", "server.js"]
