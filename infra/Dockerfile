FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --chown=node:node server ./server
USER node
EXPOSE 8787
CMD ["node", "server/index.ts"]