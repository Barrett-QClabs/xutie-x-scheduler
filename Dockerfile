FROM node:22-bookworm-slim

WORKDIR /app

ENV HOST=0.0.0.0
ENV PORT=3847
ENV DATABASE_PATH=/data/xqueue.sqlite
ENV X_API_MODE=mock
ENV XUTIE_AUTOMATION_SUPERVISOR=off

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3847

CMD ["npm", "start"]
