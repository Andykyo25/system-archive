FROM node:20-alpine

WORKDIR /app

# 先 copy package.json 利用 layer cache
COPY package.json ./
RUN npm install --omit=dev

# 再 copy 其他檔案
COPY . .

# 不打包 .env（透過 docker-compose / docker run -e 注入）
RUN rm -f .env

EXPOSE 5174

# 用 production 啟動
CMD ["node", "server/server.js"]
