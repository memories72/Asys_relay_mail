FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install && sed -i 's/data.toString("ascii")/data.toString("binary")/g' node_modules/poplib/main.js

COPY . .

EXPOSE 3000 3890
CMD ["npm", "start"]
