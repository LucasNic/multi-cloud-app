FROM node:20-alpine AS builder

ARG VITE_BACKEND_URL=http://localhost:8080
ARG VITE_STREAMER_WS_URL=ws://localhost:8081/ws

ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_STREAMER_WS_URL=$VITE_STREAMER_WS_URL

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
