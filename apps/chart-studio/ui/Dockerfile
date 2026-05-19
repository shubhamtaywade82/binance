FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY ui ./ui
RUN npm install -w @chart-studio/ui --no-audit --no-fund
RUN npm run -w @chart-studio/ui build

FROM nginx:1.27-alpine AS prod
COPY --from=build /app/ui/dist /usr/share/nginx/html
COPY ui/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
