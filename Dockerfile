FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.web.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
# The shell (index.html + favicon) is committed; the bundle is built into it below.
COPY public ./public
# The dashboard is bundled to public/app.js; the server itself compiles to dist/.
RUN npx tsc && node scripts/build-ui.mjs

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# No node_modules at runtime: the server uses only Node built-ins and serves static assets.
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./
RUN mkdir -p /app/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
