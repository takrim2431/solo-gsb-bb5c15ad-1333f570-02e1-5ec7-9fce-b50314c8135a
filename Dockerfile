FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# 先拷贝依赖清单以利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# 拷贝应用源码
COPY . .

EXPOSE 3000

USER node

CMD ["node", "server.js"]
