FROM node:20-alpine

RUN apk add --no-cache postgresql16-client

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/

ENV MEMORY_TRANSPORT=http
ENV MEMORY_PORT=3846

EXPOSE 3846

CMD ["node", "dist/index.js"]
