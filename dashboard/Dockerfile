FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

# Vite reads VITE_* env vars at dev-server startup and injects them into the bundle
CMD ["npm", "run", "dev"]
