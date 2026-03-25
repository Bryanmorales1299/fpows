FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN cat index.html | head -n 20
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
