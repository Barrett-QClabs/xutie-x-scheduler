FROM node:22-bookworm-slim

WORKDIR /app

ENV PORT=3847
ENV DATABASE_PATH=/data/xqueue.sqlite
ENV X_API_MODE=live

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3847

CMD ["npm", "start"]
