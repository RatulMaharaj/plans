# One process, one volume. Mount /data and set GITHUB_CLIENT_ID.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-package-lock
COPY src ./src
ENV HOST=0.0.0.0 PORT=8787 WORKSPACES_DB=/data/workspaces.sqlite
VOLUME /data
EXPOSE 8787
CMD ["node", "src/index.js"]
