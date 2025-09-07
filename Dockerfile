FROM node:22-alpine
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm i
COPY src ./src
RUN npm run build && npm prune --production
CMD ["node","dist/main.js"]