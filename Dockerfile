# ===== Шеф-Повар AI — production-образ =====
FROM node:20-alpine

# Рабочая директория
WORKDIR /app

# Сначала зависимости — для эффективного кэширования слоёв
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Исходный код
COPY . .

# Каталог для чеков оплаты (монтируется томом в production)
RUN mkdir -p uploads

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# Health-check для оркестраторов
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "index.js"]
