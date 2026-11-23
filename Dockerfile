FROM node:22-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.17.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["./node_modules/.bin/tsx", "main.ts"]
