FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache iputils

COPY package.json ./package.json
RUN npm install --omit=dev

COPY server.js ./server.js
COPY public ./public
COPY data ./data
COPY scripts ./scripts
COPY certs ./certs

EXPOSE 3000
CMD ["npm", "start"]
