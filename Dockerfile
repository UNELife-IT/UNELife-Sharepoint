FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
CMD ["node", "server.js"]
